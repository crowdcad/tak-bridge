// SPDX-License-Identifier: AGPL-3.0-only

import type { BackendAdapter, TakEventConfig, Unsubscribe } from './backend/types.js';
import { haversineM } from './geo.js';
import type { Logger } from './log.js';
import type { DevicePosition } from './sources/types.js';

export interface BridgeOptions {
  adapter: BackendAdapter;
  log: Logger;
  version: string;
  /** Whether the TAK side is connected, for status. */
  takConnected: () => boolean;
  now?: () => number;
  /** Write a live doc when a device has moved more than this many meters... */
  moveThresholdM?: number;
  /** ...or when this long has passed since its last write. */
  heartbeatMs?: number;
  /** How often to write bridge and event status. */
  statusIntervalMs?: number;
  /** At startup, live docs older than this are deleted. */
  staleAfterMs?: number;
}

interface LastWrite {
  lat: number;
  lon: number;
  at: number;
}

interface EventState {
  config: TakEventConfig;
  lastWrite: Map<string, LastWrite>;
  closing: boolean;
}

/**
 * Moves positions from the TAK side into the backend for every event linked
 * to this bridge.
 *
 * - Writes a device's live doc when it has moved more than 10 m or 60 s have
 *   passed since its last write (positions arrive far more often).
 * - Writes bridge and per-event status every 60 s.
 * - On first seeing an event: deletes live docs older than 10 minutes, and
 *   runs the close procedure if the event is already closed.
 * - When an event's config turns closed: deletes all its live docs and stops
 *   writing to it.
 */
export class Bridge {
  private readonly events = new Map<string, EventState>();
  private readonly seen = new Set<string>();
  private unsubscribe: Unsubscribe | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private readonly opts: Required<Omit<BridgeOptions, 'adapter' | 'log' | 'takConnected'>> &
    Pick<BridgeOptions, 'adapter' | 'log' | 'takConnected'>;
  /** In-flight live writes, and other in-flight work (sweeps, closes). Kept apart so a close can wait for writes without waiting for itself. */
  private readonly writes = new Set<Promise<unknown>>();
  private readonly ops = new Set<Promise<unknown>>();

  readonly stats = { liveWrites: 0, skipped: 0, writeErrors: 0 };

  constructor(options: BridgeOptions) {
    this.opts = {
      now: Date.now,
      moveThresholdM: 10,
      heartbeatMs: 60_000,
      statusIntervalMs: 60_000,
      staleAfterMs: 10 * 60_000,
      ...options,
    };
  }

  /** Signs in and starts watching linked events. Resolves once the first set of events has been processed. */
  async start(email: string, password: string): Promise<string> {
    const uid = await this.opts.adapter.signIn(email, password);
    this.opts.log.info('signed in as bridge account', { uid });
    await new Promise<void>((resolve) => {
      let first = true;
      this.unsubscribe = this.opts.adapter.watchLinkedEvents(
        (configs) => {
          const done = this.applyConfigs(configs);
          if (first) {
            first = false;
            void done.then(resolve);
          }
        },
        (err) => {
          this.opts.log.error('watching linked events failed', { message: err.message });
          if (first) {
            first = false;
            resolve();
          }
        },
      );
    });
    this.statusTimer = setInterval(() => void this.writeStatus(), this.opts.statusIntervalMs);
    await this.writeStatus();
    return uid;
  }

  async stop(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.flush();
  }

  /** Waits for all in-flight writes and work. */
  async flush(): Promise<void> {
    while (this.writes.size + this.ops.size > 0) await Promise.allSettled([...this.writes, ...this.ops]);
  }

  private async flushWrites(): Promise<void> {
    while (this.writes.size > 0) await Promise.allSettled([...this.writes]);
  }

  get linkedEvents(): TakEventConfig[] {
    return [...this.events.values()].map((e) => e.config);
  }

  handlePosition(position: DevicePosition): void {
    const now = this.opts.now();
    for (const [eventId, state] of this.events) {
      const { config } = state;
      if (!config.enabled || config.closed || state.closing) continue;
      const last = state.lastWrite.get(position.deviceUid);
      const due =
        !last ||
        now - last.at >= this.opts.heartbeatMs ||
        haversineM(last, position) > this.opts.moveThresholdM;
      if (!due) {
        this.stats.skipped++;
        continue;
      }
      state.lastWrite.set(position.deviceUid, { lat: position.lat, lon: position.lon, at: now });
      this.track(
        this.writes,
        this.opts.adapter.writeLivePosition(eventId, position).then(
          () => {
            this.stats.liveWrites++;
          },
          (err: Error) => {
            this.stats.writeErrors++;
            // Allow a retry on the next position.
            state.lastWrite.delete(position.deviceUid);
            this.opts.log.warn('live write failed', { eventId, deviceUid: position.deviceUid, message: err.message });
          },
        ),
      );
    }
  }

  private async applyConfigs(configs: TakEventConfig[]): Promise<void> {
    const current = new Set(configs.map((c) => c.eventId));
    for (const eventId of [...this.events.keys()]) {
      if (!current.has(eventId)) {
        // Unlinked: stop writing. The owner's browser clears live docs on unlink.
        this.events.delete(eventId);
        this.opts.log.info('event unlinked', { eventId });
      }
    }
    const work: Promise<unknown>[] = [];
    for (const config of configs) {
      const state = this.events.get(config.eventId);
      const wasClosed = state?.config.closed ?? false;
      if (state) state.config = config;
      else this.events.set(config.eventId, { config, lastWrite: new Map(), closing: false });

      if (!this.seen.has(config.eventId)) {
        this.seen.add(config.eventId);
        this.opts.log.info('event linked', { eventId: config.eventId, enabled: config.enabled, closed: config.closed });
        work.push(this.track(this.ops, this.startupSweep(config)));
      } else if (config.closed && !wasClosed) {
        work.push(this.track(this.ops, this.closeEvent(config.eventId)));
      }
    }
    await Promise.allSettled(work);
  }

  private async startupSweep(config: TakEventConfig): Promise<void> {
    if (config.closed) {
      await this.closeEvent(config.eventId);
      return;
    }
    try {
      const stale = await this.opts.adapter.listStaleLiveDevices(config.eventId, this.opts.now() - this.opts.staleAfterMs);
      if (stale.length > 0) {
        await this.opts.adapter.deleteLivePositions(config.eventId, stale);
        this.opts.log.info('removed stale live positions', { eventId: config.eventId, count: stale.length });
      }
    } catch (err) {
      this.opts.log.warn('startup sweep failed', { eventId: config.eventId, message: (err as Error).message });
    }
  }

  private async closeEvent(eventId: string): Promise<void> {
    const state = this.events.get(eventId);
    if (state) state.closing = true;
    await this.flushWrites();
    try {
      await this.opts.adapter.deleteLivePositions(eventId);
      this.opts.log.info('event closed; live positions removed', { eventId });
    } catch (err) {
      this.opts.log.warn('removing live positions at close failed', { eventId, message: (err as Error).message });
    }
    state?.lastWrite.clear();
  }

  private async writeStatus(): Promise<void> {
    const now = this.opts.now();
    const takConnected = this.opts.takConnected();
    const active = [...this.events.entries()].filter(([, s]) => s.config.enabled && !s.config.closed);
    const writes: Promise<unknown>[] = [
      this.opts.adapter.writeBridgeStatus({
        lastSeenAt: now,
        takConnected,
        version: this.opts.version,
        linkedEventCount: this.events.size,
      }),
      ...active.map(([eventId, s]) =>
        this.opts.adapter.writeEventStatus(eventId, { lastSeenAt: now, takConnected, liveDeviceCount: s.lastWrite.size }),
      ),
    ];
    const results = await Promise.allSettled(writes);
    for (const r of results) {
      if (r.status === 'rejected') this.opts.log.warn('status write failed', { message: (r.reason as Error).message });
    }
  }

  private track<T>(set: Set<Promise<unknown>>, p: Promise<T>): Promise<T> {
    set.add(p);
    p.finally(() => set.delete(p)).catch(() => {});
    return p;
  }
}
