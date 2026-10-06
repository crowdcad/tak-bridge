// SPDX-License-Identifier: AGPL-3.0-only

import type {
  BackendAdapter,
  BridgeStatus,
  DeviceLink,
  EventStatus,
  TakEventConfig,
  Unsubscribe,
} from '../backend/types.js';
import { liveDoc } from '../backend/types.js';
import type { DevicePosition } from '../sources/types.js';

/**
 * In-memory BackendAdapter for unit tests and budget simulations. It records
 * every write, and lets a test change the linked configs as an owner would.
 */
export class MemoryAdapter implements BackendAdapter {
  uid = 'BRIDGE';
  configs: TakEventConfig[] = [];
  /** eventId -> deviceUid -> live doc */
  readonly live = new Map<string, Map<string, Record<string, unknown>>>();
  readonly bridgeStatus: BridgeStatus[] = [];
  readonly eventStatus = new Map<string, EventStatus[]>();
  readonly counts = { liveWrites: 0, liveDeletes: 0, statusWrites: 0 };
  /** Events whose writes fail, to simulate rule denials. */
  readonly failingEvents = new Set<string>();
  private listener: ((configs: TakEventConfig[]) => void) | null = null;

  async signIn(): Promise<string> {
    return this.uid;
  }

  watchLinkedEvents(onChange: (configs: TakEventConfig[]) => void): Unsubscribe {
    this.listener = onChange;
    queueMicrotask(() => onChange(this.configs.map((c) => ({ ...c }))));
    return () => {
      this.listener = null;
    };
  }

  /** Replaces the linked configs and notifies the bridge, like a snapshot listener. */
  setConfigs(configs: TakEventConfig[]): void {
    this.configs = configs;
    this.listener?.(configs.map((c) => ({ ...c })));
  }

  watchDeviceLinks(_eventId: string, onChange: (links: DeviceLink[]) => void): Unsubscribe {
    queueMicrotask(() => onChange([]));
    return () => {};
  }

  async writeLivePosition(eventId: string, position: DevicePosition): Promise<void> {
    if (this.failingEvents.has(eventId)) throw new Error('permission-denied');
    if (!this.live.has(eventId)) this.live.set(eventId, new Map());
    this.live.get(eventId)!.set(position.deviceUid, liveDoc(position, this.uid));
    this.counts.liveWrites++;
  }

  async deleteLivePositions(eventId: string, deviceUids?: string[]): Promise<void> {
    const docs = this.live.get(eventId);
    if (!docs) return;
    for (const id of deviceUids ?? [...docs.keys()]) {
      if (docs.delete(id)) this.counts.liveDeletes++;
    }
  }

  async listStaleLiveDevices(eventId: string, olderThan: number): Promise<string[]> {
    const docs = this.live.get(eventId) ?? new Map();
    return [...docs.entries()].filter(([, d]) => (d.receivedAt as number) < olderThan).map(([id]) => id);
  }

  async writeBridgeStatus(status: BridgeStatus): Promise<void> {
    this.bridgeStatus.push(status);
    this.counts.statusWrites++;
  }

  async writeEventStatus(eventId: string, status: EventStatus): Promise<void> {
    if (!this.eventStatus.has(eventId)) this.eventStatus.set(eventId, []);
    this.eventStatus.get(eventId)!.push(status);
    this.counts.statusWrites++;
  }

  async close(): Promise<void> {}
}
