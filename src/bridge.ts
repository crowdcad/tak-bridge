// SPDX-License-Identifier: AGPL-3.0-only

import type { BackendAdapter, TakEventConfig, Unsubscribe } from './backend/types.js';
import { haversineM } from './geo.js';
import { HistoryRecorder } from './history/recorder.js';
import type { Logger } from './log.js';
import type { DevicePosition } from './sources/types.js';

export interface BridgeOptions {
  adapter: BackendAdapter;
  log: Logger;
  version: string;
  /** Whether the TAK side is connected, for status. */
  takConnected: () => boolean;
  /** The last TAK connection problem in plain words, for status. */
  takError?: () => string;
  now?: () => number;
  /** Write a live doc when a device has moved more than this many meters... */
  moveThresholdM?: number;
  /** ...or when this long has passed since its last write. */
  heartbeatMs?: number;
  /** How often to write bridge and event status. */
  statusIntervalMs?: number;
  /** At startup, live docs older than this are deleted. */
  staleAfterMs?: number;
  /** How often history segments are written. */
  historyFlushMs?: number;
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
  /** Location history, when the event records it. */
  recorder: HistoryRecorder | null;
  unwatchLinks: Unsubscribe | null;
  unwatchCalls: Unsubscribe | null;
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
  private historyTimer: NodeJS.Timeout | null = null;
  private readonly opts: Required<Omit<BridgeOptions, 'adapter' | 'log' | 'takConnected' | 'takError'>> &
    Pick<BridgeOptions, 'adapter' | 'log' | 'takConnected' | 'takError'>;
  /** In-flight live writes, and other in-flight work (sweeps, closes). Kept apart so a close can wait for writes without waiting for itself. */
  private readonly writes = new Set<Promise<unknown>>();
  private readonly ops = new Set<Promise<unknown>>();

  readonly stats = { liveWrites: 0, skipped: 0, writeErrors: 0, historyWrites: 0 };
  private readonly devicesSeen = new Set<string>();
  private lastPositionAt = 0;

  constructor(options: BridgeOptions) {
    this.opts = {
      now: Date.now,
      moveThresholdM: 10,
      heartbeatMs: 60_000,
      statusIntervalMs: 60_000,
      staleAfterMs: 10 * 60_000,
      historyFlushMs: 5 * 60_000,
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
    this.historyTimer = setInterval(() => void this.flushHistory(false), this.opts.historyFlushMs);
    await this.writeStatus();
    return uid;
  }

  async stop(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.historyTimer) clearInterval(this.historyTimer);
    this.statusTimer = this.historyTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.flush();
    // Keep what was recorded; segments stay open so a restart continues them as new segments.
    await this.flushHistory(false);
    for (const state of this.events.values()) this.unwatch(state);
  }

  /** Writes changed history segments and full point chunks for every event. */
  async flushHistory(final: boolean): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const [eventId, state] of this.events) {
      if (!state.recorder) continue;
      const { segments, points } = state.recorder.flush(final);
      for (const seg of segments) work.push(this.writeHistory(() => this.opts.adapter.writeHistorySegment(eventId, seg), eventId));
      for (const chunk of points) work.push(this.writeHistory(() => this.opts.adapter.writeHistoryPoints(eventId, chunk), eventId));
    }
    await Promise.allSettled(work);
  }

  private async writeHistory(write: () => Promise<void>, eventId: string): Promise<void> {
    try {
      await write();
      this.stats.historyWrites++;
    } catch (err) {
      this.stats.writeErrors++;
      this.opts.log.warn('history write failed', { eventId, message: (err as Error).message });
    }
  }

  /** Starts, updates or stops history recording to match an event's config. */
  private syncHistory(eventId: string, state: EventState): void {
    const { historyMode, enabled, closed } = state.config;
    const wanted = enabled && !closed && historyMode !== 'off';
    if (!wanted) {
      if (state.recorder && historyMode === 'off') state.recorder.setMode('off');
      if (state.unwatchCalls && historyMode !== 'detailed') {
        state.unwatchCalls();
        state.unwatchCalls = null;
      }
      return;
    }
    if (!state.recorder) state.recorder = new HistoryRecorder(historyMode);
    else state.recorder.setMode(historyMode);
    const recorder = state.recorder;
    if (!state.unwatchLinks) {
      state.unwatchLinks = this.opts.adapter.watchDeviceLinks(
        eventId,
        (links) => recorder.setLinks(new Map(links.map((l) => [l.deviceUid, l.teamId]))),
        (err) => this.opts.log.warn('watching device links failed', { eventId, message: err.message }),
      );
    }
    if (historyMode === 'detailed' && !state.unwatchCalls) {
      state.unwatchCalls = this.opts.adapter.watchCallState(
        eventId,
        (ids) => recorder.setOnCall(ids),
        (err) => this.opts.log.warn('watching call state failed', { eventId, message: err.message }),
      );
    } else if (historyMode !== 'detailed' && state.unwatchCalls) {
      state.unwatchCalls();
      state.unwatchCalls = null;
      recorder.setOnCall([]);
    }
  }

  private unwatch(state: EventState): void {
    state.unwatchLinks?.();
    state.unwatchCalls?.();
    state.unwatchLinks = state.unwatchCalls = null;
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
    this.devicesSeen.add(position.deviceUid);
    this.lastPositionAt = now;
    for (const [eventId, state] of this.events) {
      const { config } = state;
      if (!config.enabled || config.closed || state.closing) continue;
      state.recorder?.add(position);
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
        // Unlinked: stop writing (the rules no longer allow it). The owner's
        // browser clears live docs on unlink.
        this.unwatch(this.events.get(eventId)!);
        this.events.delete(eventId);
        this.opts.log.info('event unlinked', { eventId });
      }
    }
    const work: Promise<unknown>[] = [];
    for (const config of configs) {
      const state = this.events.get(config.eventId);
      const wasClosed = state?.config.closed ?? false;
      if (state) state.config = config;
      else {
        this.events.set(config.eventId, {
          config,
          lastWrite: new Map(),
          closing: false,
          recorder: null,
          unwatchLinks: null,
          unwatchCalls: null,
        });
      }
      this.syncHistory(config.eventId, this.events.get(config.eventId)!);

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
    // End open history segments and write everything recorded.
    if (state?.recorder) {
      state.recorder.closeAll(null);
      const { segments, points } = state.recorder.flush(true);
      for (const seg of segments) await this.writeHistory(() => this.opts.adapter.writeHistorySegment(eventId, seg), eventId);
      for (const chunk of points) await this.writeHistory(() => this.opts.adapter.writeHistoryPoints(eventId, chunk), eventId);
      state.recorder = null;
    }
    if (state) this.unwatch(state);
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
        devicesSeen: this.devicesSeen.size,
        lastPositionAt: this.lastPositionAt,
        takError: takConnected ? '' : (this.opts.takError?.() ?? ''),
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
