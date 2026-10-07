// SPDX-License-Identifier: AGPL-3.0-only

import type { BackendAdapter } from '../backend/types.js';
import { Bridge } from '../bridge.js';
import { createLogger } from '../log.js';
import { Simulation } from '../sim/model.js';

/**
 * One end-to-end scenario run unchanged against every backend (P6 parity
 * check). Each backend's test supplies the adapter and a few helpers that
 * act as the dispatcher or owner (writing with that backend's own tools) and
 * read results back.
 */
export interface ParityHelpers {
  adapter: BackendAdapter;
  email: string;
  password: string;
  /** An event linked to the bridge, enabled, open, history mode summary. */
  eventId: string;
  /** Dispatcher links a device to a team. */
  linkDevice(eventId: string, deviceUid: string, teamId: string): Promise<void>;
  /** Owner (or admin) marks the event's TAK config closed. */
  closeEvent(eventId: string): Promise<void>;
  liveDeviceUids(eventId: string): Promise<string[]>;
  historySegments(eventId: string): Promise<{ deviceUid: string; teamId: string; endedAt: number | null }[]>;
}

export interface ParityResult {
  linked: boolean;
  liveAfterFeed: string[];
  historyAfterFlush: { deviceUid: string; teamId: string; open: boolean }[];
  liveAfterClose: string[];
  historyAfterClose: { deviceUid: string; teamId: string; open: boolean }[];
  writeErrors: number;
}

async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function runParityScenario(h: ParityHelpers): Promise<ParityResult> {
  const bridge = new Bridge({
    adapter: h.adapter,
    log: createLogger('error', () => {}),
    version: 'parity',
    takConnected: () => true,
    statusIntervalMs: 3_600_000,
    historyFlushMs: 3_600_000,
  });
  try {
    await bridge.start(h.email, h.password);
    const linked = bridge.linkedEvents.some((e) => e.eventId === h.eventId);

    await h.linkDevice(h.eventId, 'SIM-001', 'team-1');
    // Let the bridge see the new link before positions arrive.
    await new Promise((r) => setTimeout(r, 1_500));

    const start = Date.now();
    const sim = new Simulation({ devices: 3, startTime: start, center: { lat: 45.0012, lon: -100.0021 }, reportIntervalMs: 5_000 });
    for (const f of sim.fixesBetween(start + 2 * 60_000)) bridge.handlePosition({ ...f, receivedAt: Date.now() });
    await bridge.flush();
    await bridge.flushHistory(false);

    const liveAfterFeed = (await h.liveDeviceUids(h.eventId)).sort();
    const seg = (s: { deviceUid: string; teamId: string; endedAt: number | null }) => ({ deviceUid: s.deviceUid, teamId: s.teamId, open: s.endedAt === null });
    const historyAfterFlush = (await h.historySegments(h.eventId)).map(seg);

    await h.closeEvent(h.eventId);
    const liveAfterClose = await eventually(() => h.liveDeviceUids(h.eventId), (v) => v.length === 0);
    const historyAfterClose = (
      await eventually(() => h.historySegments(h.eventId), (v) => v.length > 0 && v.every((s) => s.endedAt !== null))
    ).map(seg);

    return { linked, liveAfterFeed, historyAfterFlush, liveAfterClose, historyAfterClose, writeErrors: bridge.stats.writeErrors };
  } finally {
    await bridge.stop();
    await h.adapter.close();
  }
}

/** What every backend must produce. */
export const EXPECTED_PARITY: ParityResult = {
  linked: true,
  liveAfterFeed: ['SIM-001', 'SIM-002', 'SIM-003'],
  historyAfterFlush: [{ deviceUid: 'SIM-001', teamId: 'team-1', open: true }],
  liveAfterClose: [],
  historyAfterClose: [{ deviceUid: 'SIM-001', teamId: 'team-1', open: false }],
  writeErrors: 0,
};
