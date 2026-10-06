// SPDX-License-Identifier: AGPL-3.0-only

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInWithEmailAndPassword, signOut, type Auth } from 'firebase/auth';
import {
  collection,
  collectionGroup,
  connectFirestoreEmulator,
  doc,
  getDocs,
  initializeFirestore,
  onSnapshot,
  query,
  setDoc,
  terminate,
  where,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import type { DevicePosition } from '../sources/types.js';
import { deviceDocId, deviceUidFromDocId } from './ids.js';
import {
  liveDoc,
  type BackendAdapter,
  type BridgeStatus,
  type DeviceLink,
  type EventStatus,
  type HistoryMode,
  type TakEventConfig,
  type Unsubscribe,
} from './types.js';

export interface FirebaseAdapterOptions {
  apiKey: string;
  projectId: string;
  authDomain: string;
  /** Emulator hosts. Default to the standard FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST variables. */
  firestoreEmulatorHost?: string;
  authEmulatorHost?: string;
}

const HISTORY_MODES: readonly HistoryMode[] = ['off', 'summary', 'detailed'];

/**
 * Firebase backend for the bridge, using the Firebase client SDK in Node. The
 * bridge signs in with email and password as its bridge account; it never
 * uses the Admin SDK, so firestore.rules apply to every read and write.
 */
export class FirebaseAdapter implements BackendAdapter {
  private readonly app: FirebaseApp;
  private readonly auth: Auth;
  private readonly db: Firestore;
  private uid = '';

  constructor(options: FirebaseAdapterOptions) {
    this.app = initializeApp(
      { apiKey: options.apiKey, projectId: options.projectId, authDomain: options.authDomain },
      `tak-bridge-${Math.random().toString(36).slice(2)}`,
    );
    this.auth = getAuth(this.app);
    this.db = initializeFirestore(this.app, { ignoreUndefinedProperties: true });

    const authHost = options.authEmulatorHost ?? process.env.FIREBASE_AUTH_EMULATOR_HOST;
    if (authHost) connectAuthEmulator(this.auth, `http://${authHost}`, { disableWarnings: true });
    const fsHost = options.firestoreEmulatorHost ?? process.env.FIRESTORE_EMULATOR_HOST;
    if (fsHost) {
      const [host, port] = fsHost.split(':');
      connectFirestoreEmulator(this.db, host!, Number(port));
    }
  }

  async signIn(email: string, password: string): Promise<string> {
    const cred = await signInWithEmailAndPassword(this.auth, email, password);
    this.uid = cred.user.uid;
    return this.uid;
  }

  watchLinkedEvents(onChange: (configs: TakEventConfig[]) => void, onError: (err: Error) => void): Unsubscribe {
    const q = query(collectionGroup(this.db, 'takConfig'), where('bridgeUid', '==', this.uid));
    return onSnapshot(
      q,
      (snap) => {
        const configs: TakEventConfig[] = [];
        for (const d of snap.docs) {
          const data = d.data();
          // events/{eventId}/takConfig/current
          const eventId = typeof data.eventId === 'string' ? data.eventId : d.ref.parent.parent?.id;
          if (!eventId) continue;
          configs.push({
            eventId,
            bridgeUid: typeof data.bridgeUid === 'string' ? data.bridgeUid : null,
            enabled: data.enabled === true,
            closed: data.closed === true,
            historyMode: HISTORY_MODES.includes(data.historyMode) ? data.historyMode : 'off',
          });
        }
        onChange(configs);
      },
      onError,
    );
  }

  watchDeviceLinks(eventId: string, onChange: (links: DeviceLink[]) => void, onError: (err: Error) => void): Unsubscribe {
    return onSnapshot(
      collection(this.db, 'events', eventId, 'takDeviceLinks'),
      (snap) => {
        onChange(
          snap.docs.flatMap((d) => {
            const data = d.data();
            if (typeof data.teamId !== 'string') return [];
            return [
              {
                deviceUid: deviceUidFromDocId(d.id),
                teamId: data.teamId,
                linkedAt: typeof data.linkedAt === 'number' ? data.linkedAt : 0,
                method: data.method === 'auto' ? 'auto' : 'manual',
              },
            ];
          }),
        );
      },
      onError,
    );
  }

  async writeLivePosition(eventId: string, position: DevicePosition): Promise<void> {
    await setDoc(doc(this.db, 'events', eventId, 'takLive', deviceDocId(position.deviceUid)), liveDoc(position, this.uid));
  }

  async deleteLivePositions(eventId: string, deviceUids?: string[]): Promise<void> {
    const ids = deviceUids
      ? deviceUids.map(deviceDocId)
      : (await getDocs(collection(this.db, 'events', eventId, 'takLive'))).docs.map((d) => d.id);
    for (let i = 0; i < ids.length; i += 400) {
      const batch = writeBatch(this.db);
      for (const id of ids.slice(i, i + 400)) batch.delete(doc(this.db, 'events', eventId, 'takLive', id));
      await batch.commit();
    }
  }

  async listStaleLiveDevices(eventId: string, olderThan: number): Promise<string[]> {
    const snap = await getDocs(query(collection(this.db, 'events', eventId, 'takLive'), where('receivedAt', '<', olderThan)));
    return snap.docs.map((d) => deviceUidFromDocId(d.id));
  }

  async writeBridgeStatus(status: BridgeStatus): Promise<void> {
    await setDoc(doc(this.db, 'bridgeAccounts', this.uid, 'status', 'current'), { ...status });
  }

  async writeEventStatus(eventId: string, status: EventStatus): Promise<void> {
    await setDoc(doc(this.db, 'events', eventId, 'takStatus', 'current'), { ...status });
  }

  async close(): Promise<void> {
    try {
      await terminate(this.db);
      await signOut(this.auth);
    } finally {
      await deleteApp(this.app);
    }
  }
}
