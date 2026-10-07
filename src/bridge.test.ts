// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import type { TakEventConfig } from './backend/types.js';
import { Bridge } from './bridge.js';
import { createLogger } from './log.js';
import { Simulation } from './sim/model.js';
import type { DevicePosition } from './sources/types.js';
import { MemoryAdapter } from './testing/memory-adapter.js';

const log = createLogger('error', () => {});
const center = { lat: 45.0012, lon: -100.0021 };
const T0 = Date.parse('2026-10-07T08:00:00Z');

const cfg = (eventId: string, over: Partial<TakEventConfig> = {}): TakEventConfig => ({
  eventId,
  bridgeUid: 'BRIDGE',
  enabled: true,
  closed: false,
  historyMode: 'summary',
  ...over,
});

function setup(configs: TakEventConfig[]) {
  const adapter = new MemoryAdapter();
  adapter.configs = configs;
  let clock = T0;
  const bridge = new Bridge({
    adapter,
    log,
    version: 'test',
    takConnected: () => true,
    now: () => clock,
    statusIntervalMs: 3_600_000,
  });
  return {
    adapter,
    bridge,
    setClock: (t: number) => {
      clock = t;
    },
  };
}

const pos = (deviceUid: string, lat: number, lon: number, t: number): DevicePosition => ({
  deviceUid,
  cotType: 'a-f-G-U-C',
  lat,
  lon,
  deviceTime: t,
  receivedAt: t,
});

/** Meters north of center, as lat. */
const north = (m: number) => center.lat + m / 111_320;

describe('Bridge', () => {
  it('writes on first fix, then on >10 m movement or a 60 s heartbeat', async () => {
    const { adapter, bridge, setClock } = setup([cfg('E1')]);
    await bridge.start('e', 'p');
    const step = (t: number, m: number) => {
      setClock(t);
      bridge.handlePosition(pos('D1', north(m), center.lon, t));
    };
    step(T0, 0); // first: write
    step(T0 + 5_000, 4); // 4 m, 5 s: skip
    step(T0 + 10_000, 9); // 9 m from last write: skip
    step(T0 + 15_000, 12); // 12 m: write
    step(T0 + 50_000, 13); // 1 m, 35 s: skip
    step(T0 + 75_000, 13); // 60 s since last write: write
    await bridge.flush();
    expect(adapter.counts.liveWrites).toBe(3);
    expect(bridge.stats.skipped).toBe(3);
    expect(adapter.live.get('E1')!.get('D1')!.lat).toBeCloseTo(north(13), 9);
    await bridge.stop();
  });

  it('writes only to enabled, open, linked events', async () => {
    const { adapter, bridge } = setup([cfg('E1'), cfg('E2', { enabled: false }), cfg('E3', { closed: true })]);
    await bridge.start('e', 'p');
    bridge.handlePosition(pos('D1', center.lat, center.lon, T0));
    await bridge.flush();
    expect([...adapter.live.keys()]).toEqual(['E1']);
    await bridge.stop();
  });

  it('deletes live docs when an event closes and stops writing to it', async () => {
    const { adapter, bridge, setClock } = setup([cfg('E1')]);
    await bridge.start('e', 'p');
    bridge.handlePosition(pos('D1', center.lat, center.lon, T0));
    bridge.handlePosition(pos('D2', center.lat, center.lon, T0));
    await bridge.flush();
    expect(adapter.live.get('E1')!.size).toBe(2);

    adapter.setConfigs([cfg('E1', { closed: true })]);
    await bridge.flush();
    expect(adapter.live.get('E1')!.size).toBe(0);

    setClock(T0 + 120_000);
    bridge.handlePosition(pos('D1', north(50), center.lon, T0 + 120_000));
    await bridge.flush();
    expect(adapter.live.get('E1')!.size).toBe(0);
    await bridge.stop();
  });

  it('on startup, removes stale live docs and closes already-closed events', async () => {
    const adapter = new MemoryAdapter();
    adapter.configs = [cfg('E1'), cfg('E2', { closed: true })];
    const old = { lat: 1, lon: 1, receivedAt: T0 - 11 * 60_000 };
    const fresh = { lat: 1, lon: 1, receivedAt: T0 - 60_000 };
    adapter.live.set('E1', new Map([['OLD', old], ['FRESH', fresh]]));
    adapter.live.set('E2', new Map([['ANY', fresh]]));
    const bridge = new Bridge({ adapter, log, version: 't', takConnected: () => true, now: () => T0, statusIntervalMs: 3_600_000 });
    await bridge.start('e', 'p');
    await bridge.flush();
    expect([...adapter.live.get('E1')!.keys()]).toEqual(['FRESH']);
    expect(adapter.live.get('E2')!.size).toBe(0);
    await bridge.stop();
  });

  it('stops writing to an unlinked event', async () => {
    const { adapter, bridge } = setup([cfg('E1')]);
    await bridge.start('e', 'p');
    adapter.setConfigs([]);
    bridge.handlePosition(pos('D1', center.lat, center.lon, T0));
    await bridge.flush();
    expect(adapter.counts.liveWrites).toBe(0);
    expect(bridge.linkedEvents).toEqual([]);
    await bridge.stop();
  });

  it('retries a device after a failed write', async () => {
    const { adapter, bridge, setClock } = setup([cfg('E1')]);
    await bridge.start('e', 'p');
    adapter.failingEvents.add('E1');
    bridge.handlePosition(pos('D1', center.lat, center.lon, T0));
    await bridge.flush();
    expect(bridge.stats.writeErrors).toBe(1);
    adapter.failingEvents.clear();
    setClock(T0 + 1_000);
    bridge.handlePosition(pos('D1', center.lat, center.lon, T0 + 1_000)); // not moved, but last write failed
    await bridge.flush();
    expect(adapter.counts.liveWrites).toBe(1);
    await bridge.stop();
  });

  it('writes bridge and event status', async () => {
    const { adapter, bridge } = setup([cfg('E1'), cfg('E2', { closed: true })]);
    await bridge.start('e', 'p');
    expect(adapter.bridgeStatus.at(-1)).toMatchObject({ takConnected: true, version: 'test', linkedEventCount: 2 });
    expect([...adapter.eventStatus.keys()]).toEqual(['E1']);
    await bridge.stop();
  });

  it('keeps live writes for an 8-hour, 20-device event within budget', async () => {
    const { adapter, bridge, setClock } = setup([cfg('E1')]);
    await bridge.start('e', 'p');
    const sim = new Simulation({ devices: 20, startTime: T0, center });
    const fixes = sim.fixesBetween(T0 + 8 * 3_600_000);
    for (const f of fixes) {
      setClock(f.receivedAt);
      bridge.handlePosition(f);
    }
    await bridge.flush();
    const perDeviceHour = adapter.counts.liveWrites / 20 / 8;
    // Floor: the 60 s heartbeat alone is 60 writes per device-hour. Walking at
    // 1.3 m/s crosses 10 m about every 8 s, so moving time adds more.
    expect(perDeviceHour).toBeGreaterThanOrEqual(60);
    expect(perDeviceHour).toBeLessThan(200);
    expect(adapter.counts.liveWrites).toBeLessThan(fixes.length / 3);
    await bridge.stop();
  });
});

describe('Bridge history', () => {
  const link = (deviceUid: string, teamId: string) => ({ deviceUid, teamId, linkedAt: 1, method: 'manual' as const });
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('records linked devices only and writes segments when flushed', async () => {
    const { adapter, bridge, setClock } = setup([cfg('E1', { historyMode: 'summary' })]);
    await bridge.start('e', 'p');
    await tick();
    adapter.setLinks('E1', [link('D1', 'team-1')]);
    for (let i = 0; i < 10; i++) {
      setClock(T0 + i * 10_000);
      bridge.handlePosition(pos('D1', center.lat, center.lon, T0 + i * 10_000));
      bridge.handlePosition(pos('D2', center.lat, center.lon, T0 + i * 10_000)); // not linked
    }
    await bridge.flushHistory(false);
    const segs = [...adapter.history.get('E1')!.values()];
    expect(segs.map((s) => [s.deviceUid, s.teamId, s.endedAt])).toEqual([['D1', 'team-1', null]]);
    expect(segs[0]!.windows[0]!.secs).toBe(90);
    await bridge.stop();
  });

  it('records nothing in Off mode', async () => {
    const { adapter, bridge } = setup([cfg('E1', { historyMode: 'off' })]);
    await bridge.start('e', 'p');
    await tick();
    adapter.setLinks('E1', [link('D1', 'team-1')]);
    bridge.handlePosition(pos('D1', center.lat, center.lon, T0));
    await bridge.flushHistory(true);
    expect(adapter.counts.historyWrites).toBe(0);
    await bridge.stop();
  });

  it('ends and writes segments when the event closes', async () => {
    const { adapter, bridge, setClock } = setup([cfg('E1', { historyMode: 'summary' })]);
    await bridge.start('e', 'p');
    await tick();
    adapter.setLinks('E1', [link('D1', 'team-1')]);
    for (let i = 0; i < 3; i++) {
      setClock(T0 + i * 10_000);
      bridge.handlePosition(pos('D1', center.lat, center.lon, T0 + i * 10_000));
    }
    adapter.setConfigs([cfg('E1', { historyMode: 'summary', closed: true })]);
    await bridge.flush();
    const seg = [...adapter.history.get('E1')!.values()][0]!;
    expect(seg.endedAt).toBe(T0 + 20_000);
    expect(adapter.live.get('E1')!.size).toBe(0);
    await bridge.stop();
  });

  it('keeps Detailed points only while the team is on a call', async () => {
    const { adapter, bridge, setClock } = setup([cfg('E1', { historyMode: 'detailed' })]);
    await bridge.start('e', 'p');
    await tick();
    adapter.setLinks('E1', [link('D1', 'team-1')]);
    const feed = (from: number, to: number) => {
      for (let t = from; t < to; t += 5_000) {
        setClock(T0 + t);
        bridge.handlePosition(pos('D1', center.lat, center.lon, T0 + t));
      }
    };
    feed(0, 60_000);
    adapter.setCallState('E1', ['team-1']);
    feed(60_000, 120_000); // 4 points at 15 s spacing
    adapter.setCallState('E1', []);
    feed(120_000, 180_000);
    adapter.setConfigs([cfg('E1', { historyMode: 'detailed', closed: true })]);
    await bridge.flush();
    const points = adapter.points.flatMap((p) => p.chunk.points);
    expect(points).toHaveLength(4);
    expect(points.every((p) => p.t >= T0 + 60_000 && p.t < T0 + 120_000)).toBe(true);
    await bridge.stop();
  });
});
