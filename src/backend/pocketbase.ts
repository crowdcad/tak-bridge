// SPDX-License-Identifier: AGPL-3.0-only

import PocketBase, { ClientResponseError, type RecordModel } from 'pocketbase';
import type { DevicePosition } from '../sources/types.js';
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

export interface PocketBaseAdapterOptions {
  url: string;
  /** How often to poll for config and device-link changes. */
  pollMs?: number;
  /** How often to refresh the auth token. */
  refreshMs?: number;
}

const HISTORY_MODES: readonly HistoryMode[] = ['off', 'summary', 'detailed'];

/**
 * PocketBase backend for the bridge. It signs in as the bridge user (role
 * 'bridge'), so the collection rules from crowdcad/crowdcad's
 * scripts/setup-pocketbase.js apply.
 *
 * Changes to TAK config and device links are picked up by polling rather
 * than PocketBase realtime, which needs a browser EventSource that Node does
 * not reliably provide.
 */
export class PocketBaseAdapter implements BackendAdapter {
  private readonly pb: PocketBase;
  private readonly pollMs: number;
  private readonly refreshMs: number;
  private uid = '';
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Record ids of upserted docs, keyed by collection + natural key. */
  private readonly ids = new Map<string, string>();

  constructor(options: PocketBaseAdapterOptions) {
    this.pb = new PocketBase(options.url);
    this.pb.autoCancellation(false);
    this.pollMs = options.pollMs ?? 5_000;
    this.refreshMs = options.refreshMs ?? 30 * 60_000;
  }

  async signIn(email: string, password: string): Promise<string> {
    const auth = await this.pb.collection('users').authWithPassword(email, password);
    this.uid = auth.record.id;
    this.every(this.refreshMs, async () => {
      await this.pb.collection('users').authRefresh();
    });
    return this.uid;
  }

  watchLinkedEvents(onChange: (configs: TakEventConfig[]) => void, onError: (err: Error) => void): Unsubscribe {
    return this.poll(
      async () => {
        const records = await this.pb
          .collection('tak_event_config')
          .getFullList({ filter: this.pb.filter('bridge = {:uid}', { uid: this.uid }), sort: 'event' });
        return records.map(
          (r): TakEventConfig => ({
            eventId: r.event,
            bridgeUid: r.bridge || null,
            enabled: r.enabled === true,
            closed: r.closed === true,
            historyMode: HISTORY_MODES.includes(r.historyMode) ? r.historyMode : 'off',
          }),
        );
      },
      onChange,
      onError,
    );
  }

  watchDeviceLinks(eventId: string, onChange: (links: DeviceLink[]) => void, onError: (err: Error) => void): Unsubscribe {
    return this.poll(
      async () => {
        const records = await this.pb
          .collection('tak_device_links')
          .getFullList({ filter: this.pb.filter('event = {:eventId}', { eventId }), sort: 'deviceUid' });
        return records.map(
          (r): DeviceLink => ({
            deviceUid: r.deviceUid,
            teamId: r.teamId,
            linkedAt: typeof r.linkedAt === 'number' ? r.linkedAt : 0,
            method: r.method === 'auto' ? 'auto' : 'manual',
          }),
        );
      },
      onChange,
      onError,
    );
  }

  async writeLivePosition(eventId: string, position: DevicePosition): Promise<void> {
    const fields = liveDoc(position, this.uid);
    delete fields.bridgeUid;
    await this.upsert(
      'tak_live',
      `${eventId}|${position.deviceUid}`,
      this.pb.filter('event = {:eventId} && deviceUid = {:deviceUid}', { eventId, deviceUid: position.deviceUid }),
      { event: eventId, bridge: this.uid, deviceUid: position.deviceUid },
      fields,
    );
  }

  async deleteLivePositions(eventId: string, deviceUids?: string[]): Promise<void> {
    const records = await this.pb
      .collection('tak_live')
      .getFullList({ filter: this.pb.filter('event = {:eventId}', { eventId }), fields: 'id,deviceUid' });
    const wanted = deviceUids ? new Set(deviceUids) : null;
    for (const r of records) {
      if (wanted && !wanted.has(r.deviceUid)) continue;
      try {
        await this.pb.collection('tak_live').delete(r.id);
      } catch (err) {
        if (!(err instanceof ClientResponseError && err.status === 404)) throw err;
      }
      this.ids.delete(`tak_live:${eventId}|${r.deviceUid}`);
    }
  }

  async listStaleLiveDevices(eventId: string, olderThan: number): Promise<string[]> {
    const records = await this.pb.collection('tak_live').getFullList({
      filter: this.pb.filter('event = {:eventId} && receivedAt < {:olderThan}', { eventId, olderThan }),
      fields: 'deviceUid',
    });
    return records.map((r) => r.deviceUid as string);
  }

  async writeBridgeStatus(status: BridgeStatus): Promise<void> {
    await this.upsert(
      'tak_bridge_status',
      this.uid,
      this.pb.filter('bridge = {:uid}', { uid: this.uid }),
      { bridge: this.uid },
      { ...status },
    );
  }

  async writeEventStatus(eventId: string, status: EventStatus): Promise<void> {
    await this.upsert(
      'tak_event_status',
      eventId,
      this.pb.filter('event = {:eventId}', { eventId }),
      { event: eventId, bridge: this.uid },
      { ...status },
    );
  }

  async close(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers.clear();
    this.pb.authStore.clear();
  }

  /**
   * Updates the record identified by `key`/`filter`, or creates it with the
   * immutable `identity` fields plus `fields`. Update requests never resend
   * identity fields, which the rules forbid changing.
   */
  private async upsert(
    collection: string,
    key: string,
    filter: string,
    identity: Record<string, unknown>,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const cacheKey = `${collection}:${key}`;
    let id = this.ids.get(cacheKey);
    if (id) {
      try {
        await this.pb.collection(collection).update(id, fields);
        return;
      } catch (err) {
        if (!(err instanceof ClientResponseError && err.status === 404)) throw err;
        this.ids.delete(cacheKey);
      }
    }
    try {
      const created = await this.pb.collection(collection).create({ ...identity, ...fields });
      this.ids.set(cacheKey, created.id);
      return;
    } catch (err) {
      // Most likely the unique index: the record exists but isn't cached (e.g. after a restart).
      if (!(err instanceof ClientResponseError && err.status === 400)) throw err;
    }
    let existing: RecordModel;
    try {
      existing = await this.pb.collection(collection).getFirstListItem(filter, { fields: 'id' });
    } catch (err) {
      throw new Error(`could not create or find ${collection} record: ${(err as Error).message}`, { cause: err });
    }
    id = existing.id;
    this.ids.set(cacheKey, id);
    await this.pb.collection(collection).update(id, fields);
  }

  /** Polls `load` and calls onChange whenever the result differs from the previous one. */
  private poll<T>(load: () => Promise<T>, onChange: (value: T) => void, onError: (err: Error) => void): Unsubscribe {
    let last: string | null = null;
    let failing = false;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const value = await load();
        failing = false;
        const json = JSON.stringify(value);
        if (json !== last) {
          last = json;
          onChange(value);
        }
      } catch (err) {
        if (!failing) onError(err as Error);
        failing = true;
      } finally {
        running = false;
      }
    };
    void tick();
    const timer = this.every(this.pollMs, tick);
    return () => {
      clearInterval(timer);
      this.timers.delete(timer);
    };
  }

  private every(ms: number, fn: () => Promise<void>): NodeJS.Timeout {
    const t = setInterval(() => void fn().catch(() => {}), ms);
    this.timers.add(t);
    return t;
  }
}
