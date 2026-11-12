// SPDX-License-Identifier: AGPL-3.0-only

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
  type Firestore,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';
import { coreFile } from '../testing/core.js';

/**
 * crowdcad/crowdcad firestore.rules: the TAK block, and a regression set for
 * the existing (non-TAK) rules. Runs against the Firestore emulator.
 */

let env: RulesTestEnvironment;

const users = {
  admin: { uid: 'ADM', email: 'admin@example.org' },
  owner: { uid: 'OWN', email: 'owner@example.org' },
  shared: { uid: 'SH', email: 'shared@example.org' },
  stranger: { uid: 'STR', email: 'stranger@example.org' },
  bridge: { uid: 'BR', email: 'br1@bridge.crowdcad.org' },
  otherBridge: { uid: 'BR2', email: 'br2@bridge.crowdcad.org' },
};

function as(user: keyof typeof users): Firestore {
  const u = users[user];
  return env.authenticatedContext(u.uid, { email: u.email }).firestore() as unknown as Firestore;
}
const anon = () => env.unauthenticatedContext().firestore() as unknown as Firestore;

const now = 1_760_000_000_000;
const live = (over: Record<string, unknown> = {}) => ({
  lat: 45.001,
  lon: -100.002,
  ce: 5,
  callsign: 'Team 1',
  cotType: 'a-f-G-U-C',
  deviceTime: now,
  receivedAt: now,
  bridgeUid: 'BR',
  ...over,
});
const config = (eventId: string, over: Record<string, unknown> = {}) => ({
  eventId,
  bridgeUid: 'BR',
  enabled: true,
  closed: false,
  historyMode: 'summary',
  updatedAt: now,
  ...over,
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-crowdcad',
    firestore: { rules: coreFile('firestore.rules') },
  });
});
afterAll(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const put = (path: string, data: Record<string, unknown>) => setDoc(doc(db, path), data);
    await Promise.all([
      put('users/ADM', { isAdmin: true }),
      put('users/OWN', { email: users.owner.email }),
      put('bridgeAccounts/BR', {
        label: 'Main TAK',
        createdBy: 'ADM',
        allowedUsers: ['OWN'],
        defaultHistoryMode: 'summary',
        createdAt: now,
        updatedAt: now,
      }),
      put('bridgeAccounts/BR2', {
        label: 'Other TAK',
        createdBy: 'ADM',
        allowedUsers: [],
        defaultHistoryMode: 'off',
        createdAt: now,
        updatedAt: now,
      }),
      // E1: linked to BR, shared with SH. Contains call data the bridge must never see.
      put('events/E1', { userId: 'OWN', sharedWith: [users.shared.email], mapMode: 'tak', calls: [{ chiefComplaint: 'x' }] }),
      put('events/E1/takConfig/current', config('E1')),
      put('events/E1/takDeviceLinks/DEV1', { teamId: 't1', linkedAt: now, method: 'auto', linkedBy: 'OWN' }),
      put('events/E1/takMapAlignment/L1', { mapUrl: 'x', residualM: 2 }),
      put('events/E1/takHistory/SEG1', { bridgeUid: 'BR', deviceUid: 'DEV1', teamId: 't1' }),
      // E2: TAK event, no bridge linked yet.
      put('events/E2', { userId: 'OWN', mapMode: 'tak' }),
      // E3: linked but closed.
      put('events/E3', { userId: 'OWN', mapMode: 'tak' }),
      put('events/E3/takConfig/current', config('E3', { closed: true })),
      put('events/E3/takLive/DEV1', live()),
      // E4: org-wide event linked to BR, history off.
      put('events/E4', { userId: 'STR', isOrgEvent: true, mapMode: 'tak' }),
      put('events/E4/takConfig/current', config('E4', { historyMode: 'off' })),
      // E5: linked, detailed history.
      put('events/E5', { userId: 'OWN', mapMode: 'tak' }),
      put('events/E5/takConfig/current', config('E5', { historyMode: 'detailed' })),
      // STD: a standard event.
      put('events/STD', { userId: 'OWN', sharedWith: [users.shared.email] }),
      put('venues/V1', { userId: 'OWN', sharedWith: [users.shared.email] }),
      put('venues/V2', { userId: 'STR', isOrgVenue: true }),
    ]);
  });
});

describe('bridge account: no patient data, no escalation', () => {
  it('cannot read or list event documents, even shared or org-wide ones', async () => {
    const db = as('bridge');
    await assertFails(getDoc(doc(db, 'events/E1')));
    await assertFails(getDoc(doc(db, 'events/E4')));
    await assertFails(getDocs(query(collection(db, 'events'), where('isOrgEvent', '==', true))));
    await assertFails(getDocs(query(collection(db, 'events'), where('userId', '==', 'OWN'))));
  });

  it('cannot write event documents', async () => {
    const db = as('bridge');
    await assertFails(updateDoc(doc(db, 'events/E4'), { calls: [] }));
    await assertFails(setDoc(doc(db, 'events/NEW'), { userId: 'BR' }));
  });

  it('cannot create or edit bridge records, TAK config, device links or mappings', async () => {
    const db = as('bridge');
    await assertFails(updateDoc(doc(db, 'bridgeAccounts/BR'), { allowedUsers: ['BR'] }));
    await assertFails(
      setDoc(doc(db, 'bridgeAccounts/BR3'), { label: 'x', createdBy: 'BR', allowedUsers: [], defaultHistoryMode: 'off' }),
    );
    await assertFails(setDoc(doc(db, 'events/E1/takConfig/current'), config('E1', { historyMode: 'detailed' })));
    await assertFails(setDoc(doc(db, 'events/E2/takConfig/current'), config('E2')));
    await assertFails(
      setDoc(doc(db, 'events/E1/takDeviceLinks/DEV2'), { teamId: 't2', linkedAt: now, method: 'manual', linkedBy: 'BR' }),
    );
    await assertFails(
      setDoc(doc(db, 'bridgeAccounts/BR/deviceMappings/DEV2'), { teamName: 'Team 2', updatedAt: now, updatedBy: 'BR' }),
    );
  });

  it('finds its linked events by a collection-group query on takConfig', async () => {
    const db = as('bridge');
    await assertSucceeds(getDocs(query(collectionGroup(db, 'takConfig'), where('bridgeUid', '==', 'BR'))));
    await assertFails(getDocs(query(collectionGroup(db, 'takConfig'), where('bridgeUid', '==', 'BR2'))));
    await assertSucceeds(getDoc(doc(db, 'bridgeAccounts/BR')));
  });

  it('reads device links of linked events only, and never map alignment', async () => {
    await assertSucceeds(getDocs(collection(as('bridge'), 'events/E1/takDeviceLinks')));
    await assertFails(getDocs(collection(as('otherBridge'), 'events/E1/takDeviceLinks')));
    await assertFails(getDoc(doc(as('bridge'), 'events/E1/takMapAlignment/L1')));
  });
});

describe('bridge account: live, history and status writes', () => {
  it('writes live positions to linked, enabled, open events', async () => {
    await assertSucceeds(setDoc(doc(as('bridge'), 'events/E1/takLive/DEV1'), live()));
    await assertSucceeds(setDoc(doc(as('bridge'), 'events/E4/takLive/DEV1'), live()));
  });

  it('rejects live writes to unlinked, closed or other bridges’ events', async () => {
    await assertFails(setDoc(doc(as('bridge'), 'events/E2/takLive/DEV1'), live()));
    await assertFails(setDoc(doc(as('bridge'), 'events/E3/takLive/DEV1'), live()));
    await assertFails(setDoc(doc(as('bridge'), 'events/STD/takLive/DEV1'), live()));
    await assertFails(setDoc(doc(as('otherBridge'), 'events/E1/takLive/DEV1'), live({ bridgeUid: 'BR2' })));
  });

  it('rejects malformed live docs', async () => {
    const db = as('bridge');
    await assertFails(setDoc(doc(db, 'events/E1/takLive/DEV1'), live({ bridgeUid: 'BR2' })));
    await assertFails(setDoc(doc(db, 'events/E1/takLive/DEV1'), live({ lat: 123 })));
    await assertFails(setDoc(doc(db, 'events/E1/takLive/DEV1'), live({ teamName: 'Team 1' })));
  });

  it('deletes live docs at close, even after closed is set', async () => {
    await assertSucceeds(deleteDoc(doc(as('bridge'), 'events/E3/takLive/DEV1')));
  });

  it('writes history only when the event records it', async () => {
    const seg = { bridgeUid: 'BR', deviceUid: 'DEV1', teamId: 't1', windows: [] };
    await assertSucceeds(setDoc(doc(as('bridge'), 'events/E1/takHistory/SEG2'), seg));
    await assertFails(setDoc(doc(as('bridge'), 'events/E4/takHistory/SEG2'), seg)); // history off
    await assertFails(setDoc(doc(as('bridge'), 'events/E1/takHistory/SEG1/points/0'), { points: [] })); // summary only
    await assertSucceeds(setDoc(doc(as('bridge'), 'events/E5/takHistory/SEG1/points/0'), { points: [] }));
  });

  it('may finish history after close, but not when the config is disabled', async () => {
    const seg = { bridgeUid: 'BR', deviceUid: 'DEV1', teamId: 't1', endedAt: now };
    await assertSucceeds(setDoc(doc(as('bridge'), 'events/E3/takHistory/SEGC'), seg)); // E3 is closed
    await env.withSecurityRulesDisabled((ctx) => updateDoc(doc(ctx.firestore(), 'events/E1/takConfig/current'), { enabled: false }));
    await assertFails(setDoc(doc(as('bridge'), 'events/E1/takHistory/SEGD'), seg));
  });

  it('reads call state (opaque team ids) but cannot write it', async () => {
    await env.withSecurityRulesDisabled((ctx) =>
      setDoc(doc(ctx.firestore(), 'events/E1/takCallState/current'), { teamIdsOnCall: ['t1'], updatedAt: now }),
    );
    await assertSucceeds(getDoc(doc(as('bridge'), 'events/E1/takCallState/current')));
    await assertFails(setDoc(doc(as('bridge'), 'events/E1/takCallState/current'), { teamIdsOnCall: [], updatedAt: now }));
    await assertFails(getDoc(doc(as('otherBridge'), 'events/E1/takCallState/current')));
  });

  it('writes its own status only', async () => {
    const status = { lastSeenAt: now, takConnected: true, version: '0', linkedEventCount: 1 };
    await assertSucceeds(setDoc(doc(as('bridge'), 'bridgeAccounts/BR/status/current'), status));
    await assertFails(setDoc(doc(as('bridge'), 'bridgeAccounts/BR2/status/current'), status));
    await assertSucceeds(setDoc(doc(as('bridge'), 'events/E1/takStatus/current'), { lastSeenAt: now }));
    await assertFails(setDoc(doc(as('bridge'), 'events/E2/takStatus/current'), { lastSeenAt: now }));
  });

  it('loses all write access when its record is deleted (revocation)', async () => {
    await assertSucceeds(deleteDoc(doc(as('admin'), 'bridgeAccounts/BR')));
    await assertFails(setDoc(doc(as('bridge'), 'events/E1/takLive/DEV1'), live()));
    await assertFails(setDoc(doc(as('bridge'), 'bridgeAccounts/BR/status/current'), { lastSeenAt: now }));
  });
});

describe('admins manage bridges; owners link allowed bridges', () => {
  const account = { label: 'New', createdBy: 'ADM', allowedUsers: ['OWN'], defaultHistoryMode: 'summary', createdAt: now, updatedAt: now };

  it('only admins create, edit and delete bridge records', async () => {
    await assertSucceeds(setDoc(doc(as('admin'), 'bridgeAccounts/BR9'), account));
    await assertFails(setDoc(doc(as('owner'), 'bridgeAccounts/BR8'), { ...account, createdBy: 'OWN' }));
    await assertFails(setDoc(doc(as('admin'), 'bridgeAccounts/ADM'), account)); // not for oneself
    await assertSucceeds(updateDoc(doc(as('admin'), 'bridgeAccounts/BR'), { allowedUsers: ['OWN', 'SH'] }));
    await assertFails(updateDoc(doc(as('owner'), 'bridgeAccounts/BR'), { allowedUsers: ['OWN', 'STR'] }));
    await assertFails(deleteDoc(doc(as('owner'), 'bridgeAccounts/BR')));
  });

  it('allowed users can list the bridges they may use; others cannot read them', async () => {
    await assertSucceeds(getDocs(query(collection(as('owner'), 'bridgeAccounts'), where('allowedUsers', 'array-contains', 'OWN'))));
    await assertFails(getDoc(doc(as('stranger'), 'bridgeAccounts/BR')));
    await assertSucceeds(getDoc(doc(as('owner'), 'bridgeAccounts/BR/status/current')));
  });

  it('an event owner links only bridges they are allowed to use', async () => {
    await assertSucceeds(setDoc(doc(as('owner'), 'events/E2/takConfig/current'), config('E2')));
    await assertFails(setDoc(doc(as('owner'), 'events/E2/takConfig/current'), config('E2', { bridgeUid: 'BR2' })));
    await assertSucceeds(updateDoc(doc(as('owner'), 'events/E1/takConfig/current'), { bridgeUid: null, updatedAt: now }));
  });

  it('only the owner manages TAK config; an admin can only close it', async () => {
    await assertFails(setDoc(doc(as('shared'), 'events/E1/takConfig/current'), config('E1', { historyMode: 'off' })));
    await assertSucceeds(updateDoc(doc(as('admin'), 'events/E1/takConfig/current'), { closed: true, updatedAt: now }));
    await assertFails(updateDoc(doc(as('admin'), 'events/E1/takConfig/current'), { bridgeUid: 'BR2' }));
    await assertSucceeds(updateDoc(doc(as('owner'), 'events/E1/takConfig/current'), { closed: true, updatedAt: now }));
  });

  it('device mappings: admins and allowed users write, others cannot', async () => {
    const m = (by: string) => ({ teamName: 'Team 2', callsign: 'Team 2', updatedAt: now, updatedBy: by });
    await assertSucceeds(setDoc(doc(as('owner'), 'bridgeAccounts/BR/deviceMappings/DEV2'), m('OWN')));
    await assertSucceeds(setDoc(doc(as('admin'), 'bridgeAccounts/BR/deviceMappings/DEV3'), m('ADM')));
    await assertFails(setDoc(doc(as('stranger'), 'bridgeAccounts/BR/deviceMappings/DEV4'), m('STR')));
    await assertFails(setDoc(doc(as('owner'), 'bridgeAccounts/BR/deviceMappings/DEV5'), m('ADM')));
  });
});

describe('dispatchers and viewers', () => {
  it('anyone who can read the event reads live positions and status', async () => {
    await env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'events/E1/takLive/DEV1'), live()));
    await assertSucceeds(getDoc(doc(as('owner'), 'events/E1/takLive/DEV1')));
    await assertSucceeds(getDoc(doc(as('shared'), 'events/E1/takLive/DEV1')));
    await assertSucceeds(getDocs(collection(as('stranger'), 'events/E4/takLive'))); // org-wide event
    await assertFails(getDoc(doc(as('stranger'), 'events/E1/takLive/DEV1')));
    await assertFails(getDoc(doc(anon(), 'events/E1/takLive/DEV1')));
  });

  it('only the event owner reads history (v1)', async () => {
    await assertSucceeds(getDoc(doc(as('owner'), 'events/E1/takHistory/SEG1')));
    await assertFails(getDoc(doc(as('shared'), 'events/E1/takHistory/SEG1')));
    await assertFails(getDoc(doc(as('admin'), 'events/E1/takHistory/SEG1')));
  });

  it('dispatchers link devices as themselves; non-bridges never write live data', async () => {
    const link = (by: string) => ({ teamId: 't2', linkedAt: now, method: 'manual', linkedBy: by });
    await assertSucceeds(setDoc(doc(as('shared'), 'events/E1/takDeviceLinks/DEV2'), link('SH')));
    await assertFails(setDoc(doc(as('shared'), 'events/E1/takDeviceLinks/DEV3'), link('OWN')));
    await assertFails(setDoc(doc(as('stranger'), 'events/E1/takDeviceLinks/DEV4'), link('STR')));
    await assertFails(setDoc(doc(as('owner'), 'events/E1/takLive/DEV9'), live({ bridgeUid: 'OWN' })));
  });

  it('dispatchers publish call state as opaque ids only', async () => {
    await assertSucceeds(setDoc(doc(as('shared'), 'events/E1/takCallState/current'), { teamIdsOnCall: ['t1', 't2'], updatedAt: now }));
    await assertFails(
      setDoc(doc(as('shared'), 'events/E1/takCallState/current'), { teamIdsOnCall: ['t1'], updatedAt: now, chiefComplaint: 'x' }),
    );
    await assertFails(setDoc(doc(as('stranger'), 'events/E1/takCallState/current'), { teamIdsOnCall: [], updatedAt: now }));
  });

  it('map alignment: readers read, only the owner writes', async () => {
    await assertSucceeds(getDoc(doc(as('shared'), 'events/E1/takMapAlignment/L1')));
    await assertFails(setDoc(doc(as('shared'), 'events/E1/takMapAlignment/L1'), { mapUrl: 'y' }));
    await assertSucceeds(setDoc(doc(as('owner'), 'events/E1/takMapAlignment/L1'), { mapUrl: 'y' }));
  });

  it('mapMode is protected: shared users cannot change it, the owner can', async () => {
    await assertFails(updateDoc(doc(as('shared'), 'events/STD'), { mapMode: 'tak' }));
    await assertSucceeds(updateDoc(doc(as('owner'), 'events/STD'), { mapMode: 'tak' }));
  });
});

describe('existing (non-TAK) rules are unchanged', () => {
  it('signed-out users read nothing', async () => {
    await assertFails(getDoc(doc(anon(), 'events/STD')));
    await assertFails(getDocs(collection(anon(), 'events')));
    await assertFails(getDoc(doc(anon(), 'venues/V1')));
  });

  it('owners, shared users, org-wide items and admins read as before', async () => {
    await assertSucceeds(getDocs(query(collection(as('owner'), 'events'), where('userId', '==', 'OWN'))));
    await assertSucceeds(getDocs(query(collection(as('shared'), 'events'), where('sharedWith', 'array-contains', users.shared.email))));
    await assertSucceeds(getDocs(query(collection(as('shared'), 'venues'), where('sharedWith', 'array-contains', users.shared.email))));
    await assertSucceeds(getDocs(query(collection(as('stranger'), 'events'), where('isOrgEvent', '==', true))));
    await assertSucceeds(getDocs(query(collection(as('stranger'), 'venues'), where('isOrgVenue', '==', true))));
    await assertSucceeds(getDoc(doc(as('admin'), 'events/STD')));
    await assertFails(getDoc(doc(as('stranger'), 'events/STD')));
    await assertFails(getDocs(collection(as('stranger'), 'events')));
  });

  it('dispatch writes and protected fields behave as before', async () => {
    await assertSucceeds(updateDoc(doc(as('shared'), 'events/STD'), { calls: [] }));
    await assertFails(updateDoc(doc(as('shared'), 'events/STD'), { sharedWith: [] }));
    await assertSucceeds(updateDoc(doc(as('owner'), 'events/STD'), { ended: true }));
    await assertSucceeds(setDoc(doc(as('stranger'), 'events/NEW'), { userId: 'STR' }));
    await assertFails(setDoc(doc(as('stranger'), 'events/NEW2'), { userId: 'OWN' }));
  });
});

/**
 * MCI role logins (crowdcad/crowdcad#142, #155): accounts with a
 * <username>@role.crowdcad.org email, made by a dispatcher for one event. They
 * read only that event's MCI documents and its TAK map data, never the event
 * document, and write nothing directly (their changes go through a server
 * route with the Admin SDK).
 */
describe('MCI role logins', () => {
  const role = (uid: string, username: string) =>
    env.authenticatedContext(uid, { email: `${username}@role.crowdcad.org` }).firestore() as unknown as Firestore;
  const responder = () => role('RA', 'resp-abcd');
  const account = (uid: string, eventId: string, over: Record<string, unknown> = {}) => ({
    uid,
    eventId,
    role: 'responder',
    username: `resp-${uid.toLowerCase()}`,
    disabled: false,
    createdBy: 'OWN',
    ...over,
  });

  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      const put = (path: string, data: Record<string, unknown>) => setDoc(doc(db, path), data);
      await Promise.all([
        put('events/M1', { userId: 'OWN', mapMode: 'tak', calls: [{ chiefComplaint: 'x' }] }),
        put('events/M1/roleAccounts/RA', account('RA', 'M1')),
        put('events/M1/roleAccounts/RB', account('RB', 'M1', { role: 'transport' })),
        put('events/M1/roleAccounts/RL', account('RL', 'M1', { role: 'logistics' })),
        put('events/M1/roleAccounts/RI', account('RI', 'M1', { role: 'incident_command' })),
        put('events/M1/roleAccounts/RT', account('RT', 'M1', { role: 'triage' })),
        put('events/M1/roleAccounts/RD', account('RD', 'M1', { disabled: true })),
        put('roleAccountIndex/RA', { eventId: 'M1', role: 'responder' }),
        put('events/M1/mci/state', { active: true }),
        put('events/M1/mci/units', { units: [] }),
        put('events/M1/mci/map', { layers: [] }),
        put('events/M1/mci/patients', { patients: { p1: { age: '34', complaint: 'ankle' } }, updatedAt: now }),
        put('events/M1/takConfig/current', config('M1')),
        put('events/M1/takMapAlignment/L1', { mapUrl: 'x', residualM: 2 }),
        put('events/M1/takDeviceLinks/DEV1', { teamId: 't1', linkedAt: now, method: 'auto', linkedBy: 'OWN' }),
        put('events/M1/takLive/DEV1', live()),
        // M2: another event's MCI. M3: an ended event with a login.
        put('events/M2', { userId: 'OWN' }),
        put('events/M2/mci/state', { active: true }),
        put('events/M3', { userId: 'OWN', ended: true }),
        put('events/M3/roleAccounts/RE', account('RE', 'M3')),
        put('events/M3/mci/state', { active: true }),
      ]);
    });
  });

  it("an active login reads its event's MCI documents and TAK map data", async () => {
    const db = responder();
    for (const path of ['mci/state', 'mci/units', 'mci/map', 'mci/patients', 'takConfig/current', 'takMapAlignment/L1', 'takDeviceLinks/DEV1', 'takLive/DEV1']) {
      await assertSucceeds(getDoc(doc(db, `events/M1/${path}`)));
    }
    await assertSucceeds(getDocs(collection(db, 'events/M1/takLive')));
    await assertSucceeds(getDocs(collection(db, 'events/M1/takDeviceLinks')));
    await assertSucceeds(getDoc(doc(db, 'events/M1/roleAccounts/RA')));
    await assertSucceeds(getDoc(doc(db, 'roleAccountIndex/RA')));
  });

  it('patient details: responders, transport and incident command read them; logistics does not', async () => {
    for (const [uid, username] of [['RA', 'resp-abcd'], ['RB', 'trans-rb'], ['RI', 'ic-ri'], ['RT', 'tri-rt']]) {
      await assertSucceeds(getDoc(doc(role(uid, username), 'events/M1/mci/patients')));
    }
    const logistics = role('RL', 'log-rl');
    await assertFails(getDoc(doc(logistics, 'events/M1/mci/patients')));
    // Logistics still reads what its view needs.
    for (const name of ['state', 'units', 'map']) await assertSucceeds(getDoc(doc(logistics, `events/M1/mci/${name}`)));
    await assertSucceeds(getDoc(doc(as('owner'), 'events/M1/mci/patients')));
    await assertFails(getDoc(doc(as('stranger'), 'events/M1/mci/patients')));
  });

  it('never reads the event document, other events, other logins or TAK history', async () => {
    const db = responder();
    await assertFails(getDoc(doc(db, 'events/M1')));
    await assertFails(getDoc(doc(db, 'events/M2/mci/state')));
    await assertFails(getDoc(doc(db, 'events/M1/roleAccounts/RB')));
    await assertFails(getDocs(collection(db, 'events/M1/roleAccounts')));
    await assertFails(getDoc(doc(db, 'events/E1/takHistory/SEG1')));
    // Org-wide items are for normal accounts only.
    await assertFails(getDoc(doc(db, 'events/E4')));
    await assertFails(getDocs(query(collection(db, 'events'), where('isOrgEvent', '==', true))));
    await assertFails(getDoc(doc(db, 'venues/V2')));
  });

  it('writes nothing directly', async () => {
    const db = responder();
    await assertFails(setDoc(doc(db, 'events/M1/mci/state'), { active: false }));
    await assertFails(setDoc(doc(db, 'events/M1/mci/patients'), { patients: {}, updatedAt: now }));
    await assertFails(updateDoc(doc(db, 'events/M1'), { calls: [] }));
    await assertFails(updateDoc(doc(db, 'events/M1/roleAccounts/RA'), { disabled: false }));
    await assertFails(setDoc(doc(db, 'events/M1/takDeviceLinks/DEV2'), { teamId: 't1', linkedAt: now, method: 'manual', linkedBy: 'RA' }));
    await assertFails(setDoc(doc(db, 'events/OWNED'), { userId: 'RA' }));
  });

  it('a disabled login, or a login on an ended event, reads nothing', async () => {
    await assertFails(getDoc(doc(role('RD', 'resp-rd'), 'events/M1/mci/state')));
    await assertFails(getDoc(doc(role('RD', 'resp-rd'), 'events/M1/takLive/DEV1')));
    await assertFails(getDoc(doc(role('RE', 'resp-re'), 'events/M3/mci/state')));
  });

  it('a self-made account with a role email gains nothing', async () => {
    const db = role('FAKE', 'resp-fake');
    await assertFails(getDoc(doc(db, 'events/M1/mci/state')));
    await assertFails(getDoc(doc(db, 'events/M1/takLive/DEV1')));
    await assertFails(setDoc(doc(db, 'events/FAKE1'), { userId: 'FAKE' }));
  });

  it('dispatchers manage logins and write the MCI documents by their fixed names', async () => {
    const db = as('owner');
    for (const name of ['state', 'units', 'map', 'patients']) {
      await assertSucceeds(setDoc(doc(db, `events/M1/mci/${name}`), { updatedAt: now }));
    }
    await assertFails(setDoc(doc(db, 'events/M1/mci/other'), { updatedAt: now }));
    await assertFails(setDoc(doc(as('stranger'), 'events/M1/mci/state'), { updatedAt: now }));
    await assertSucceeds(getDocs(collection(db, 'events/M1/roleAccounts')));
    await assertSucceeds(updateDoc(doc(db, 'events/M1/roleAccounts/RA'), { disabled: true, disabledAt: now }));
    await assertFails(updateDoc(doc(db, 'events/M1/roleAccounts/RA'), { role: 'incident_command' }));
    await assertSucceeds(
      setDoc(doc(db, 'events/M1/roleAccounts/RN'), account('RN', 'M1', { role: 'responder', createdBy: 'OWN' })),
    );
    await assertFails(setDoc(doc(db, 'events/M1/roleAccounts/RX'), account('RX', 'M1', { role: 'admin' })));
  });
});
