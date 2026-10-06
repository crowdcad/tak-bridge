// SPDX-License-Identifier: AGPL-3.0-only

import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from 'firebase/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Bridge } from '../bridge.js';
import { createLogger } from '../log.js';
import { Simulation } from '../sim/model.js';
import { coreFile } from '../testing/core.js';
import { FirebaseAdapter } from './firebase.js';

/**
 * End to end against the Firestore and Auth emulators, under crowdcad/crowdcad's
 * real rules: the bridge signs in as a bridge account with the client SDK and
 * writes live positions and status.
 */
const PROJECT = 'demo-crowdcad';
const log = createLogger('error', () => {});
const center = { lat: 37.8715, lon: -122.273 };

let env: RulesTestEnvironment;
let bridgeUid: string;
const password = 'bridge-test-password';
let email: string;
let adapter: FirebaseAdapter | null = null;
let bridge: Bridge | null = null;

async function createAuthUser(emailAddr: string, pw: string): Promise<string> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!host) throw new Error('FIREBASE_AUTH_EMULATOR_HOST is not set; run with npm run test:emulator');
  const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailAddr, password: pw, returnSecureToken: true }),
  });
  const body = (await res.json()) as { localId?: string };
  if (!body.localId) throw new Error('could not create emulator user');
  return body.localId;
}

type AdminDb = ReturnType<ReturnType<RulesTestEnvironment['authenticatedContext']>['firestore']>;
/** Runs fn with rules disabled and returns its result (withSecurityRulesDisabled itself resolves to void). */
async function admin<T>(fn: (db: AdminDb) => Promise<T>): Promise<T> {
  let result: T | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    result = await fn(ctx.firestore());
  });
  return result as T;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: coreFile('firestore.rules') } });
});
afterAll(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  email = `b${Date.now()}${Math.floor(Math.random() * 1e6)}@bridge.crowdcad.org`;
  bridgeUid = await createAuthUser(email, password);
  const now = Date.now();
  await admin(async (db) => {
    await setDoc(doc(db, 'users/ADM'), { isAdmin: true });
    await setDoc(doc(db, `bridgeAccounts/${bridgeUid}`), {
      label: 'Test TAK',
      createdBy: 'ADM',
      allowedUsers: ['OWN'],
      defaultHistoryMode: 'summary',
      createdAt: now,
      updatedAt: now,
    });
    await setDoc(doc(db, 'events/E1'), { userId: 'OWN', mapMode: 'tak', calls: [{ chiefComplaint: 'private' }] });
    await setDoc(doc(db, 'events/E1/takConfig/current'), {
      eventId: 'E1',
      bridgeUid,
      enabled: true,
      closed: false,
      historyMode: 'summary',
      updatedAt: now,
    });
    await setDoc(doc(db, 'events/E2'), { userId: 'OWN', mapMode: 'tak' }); // not linked
  });
});

afterEach(async () => {
  await bridge?.stop();
  await adapter?.close();
  bridge = null;
  adapter = null;
});

async function startBridge(): Promise<Bridge> {
  adapter = new FirebaseAdapter({ apiKey: 'fake-api-key', projectId: PROJECT, authDomain: 'localhost' });
  bridge = new Bridge({ adapter, log, version: 'test', takConnected: () => true, statusIntervalMs: 3_600_000 });
  await bridge.start(email, password);
  return bridge;
}

function feed(b: Bridge, minutes: number, devices = 3): void {
  const sim = new Simulation({ devices, startTime: Date.now(), center });
  for (const f of sim.fixesBetween(Date.now() + minutes * 60_000)) {
    b.handlePosition({ ...f, receivedAt: Date.now() });
  }
}

describe('FirebaseAdapter + Bridge against the emulator', () => {
  it('signs in, finds its linked event, and writes live docs there only', async () => {
    const b = await startBridge();
    expect(b.linkedEvents.map((e) => e.eventId)).toEqual(['E1']);
    feed(b, 2);
    await b.flush();
    expect(b.stats.writeErrors).toBe(0);

    const live = await admin((db) => getDocs(collection(db, 'events/E1/takLive')));
    expect(live.docs.map((d) => d.id).sort()).toEqual(['SIM-001', 'SIM-002', 'SIM-003']);
    const one = live.docs[0]!.data();
    expect(one.bridgeUid).toBe(bridgeUid);
    expect(one).not.toHaveProperty('teamName');
    const other = await admin((db) => getDocs(collection(db, 'events/E2/takLive')));
    expect(other.size).toBe(0);

    const status = await admin((db) => getDoc(doc(db, `bridgeAccounts/${bridgeUid}/status/current`)));
    expect(status.data()).toMatchObject({ takConnected: true, linkedEventCount: 1 });
    const evStatus = await admin((db) => getDoc(doc(db, 'events/E1/takStatus/current')));
    expect(evStatus.exists()).toBe(true);
  });

  it('removes live docs when the owner ends the event', async () => {
    const b = await startBridge();
    feed(b, 1);
    await b.flush();
    await admin((db) => updateDoc(doc(db, 'events/E1/takConfig/current'), { closed: true }));
    await waitFor(async () => (await admin((db) => getDocs(collection(db, 'events/E1/takLive')))).size === 0);
  });

  it('starts writing when an event is linked while running', async () => {
    const b = await startBridge();
    await admin((db) =>
      setDoc(doc(db, 'events/E2/takConfig/current'), {
        eventId: 'E2',
        bridgeUid,
        enabled: true,
        closed: false,
        historyMode: 'off',
        updatedAt: Date.now(),
      }),
    );
    await waitFor(async () => b.linkedEvents.length === 2);
    feed(b, 1);
    await b.flush();
    expect((await admin((db) => getDocs(collection(db, 'events/E2/takLive')))).size).toBe(3);
  });

  it('is refused by the rules once revoked', async () => {
    const b = await startBridge();
    await admin((db) => deleteDoc(doc(db, `bridgeAccounts/${bridgeUid}`)));
    feed(b, 1, 1);
    await b.flush();
    expect(b.stats.writeErrors).toBeGreaterThan(0);
    expect((await admin((db) => getDocs(collection(db, 'events/E1/takLive')))).size).toBe(0);
  });
});
