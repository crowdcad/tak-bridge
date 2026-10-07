// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Simulation } from '../sim/model.js';
import type { DevicePosition } from '../sources/types.js';
import { HistoryRecorder } from './recorder.js';

const center = { lat: 45.0012, lon: -100.0021 };
const T0 = Date.parse('2026-10-07T08:00:00Z');
const MIN = 60_000;
const north = (m: number) => center.lat + m / 111_195;

const fix = (deviceUid: string, t: number, lat = center.lat, lon = center.lon): DevicePosition => ({
  deviceUid,
  cotType: 'a-f-G-U-C',
  lat,
  lon,
  deviceTime: t,
  receivedAt: t,
});

describe('HistoryRecorder', () => {
  it('records nothing for unlinked devices or in Off mode', () => {
    const r = new HistoryRecorder('summary');
    r.add(fix('D1', T0));
    expect(r.flush().segments).toEqual([]);
    const off = new HistoryRecorder('off');
    off.setLinks(new Map([['D1', 't1']]));
    off.add(fix('D1', T0));
    expect(off.flush().segments).toEqual([]);
  });

  it('time-weights windows: each fix gets the time until the next, capped', () => {
    const r = new HistoryRecorder('summary', { maxGapMs: 60_000 });
    r.setLinks(new Map([['D1', 't1']]));
    r.add(fix('D1', T0, north(0)));
    r.add(fix('D1', T0 + 10_000, north(100))); // first fix gets 10 s at 0 m
    r.add(fix('D1', T0 + 40_000, north(100))); // second gets 30 s at 100 m
    r.add(fix('D1', T0 + 4 * MIN, north(0))); // third gets 60 s (capped) at 100 m
    const [seg] = r.flush().segments;
    expect(seg!.windows).toHaveLength(1);
    const w = seg!.windows[0]!;
    expect(w.n).toBe(4);
    expect(w.secs).toBe(100);
    // Weighted mean: (10*0 + 90*100) / 100 = 90 m north.
    expect((w.lat - center.lat) * 111_195).toBeCloseTo(90, 0);
    // Spread around the mean: sqrt(10*90^2 + 90*10^2) / 10 = 30 m.
    expect(w.spreadM).toBeCloseTo(30, 0);
  });

  it('splits into 5-minute windows and fills a 5 m heat-map grid', () => {
    const r = new HistoryRecorder('summary');
    r.setLinks(new Map([['D1', 't1']]));
    for (let t = 0; t <= 12 * MIN; t += 10_000) r.add(fix('D1', T0 + t, north(Math.floor(t / (6 * MIN)) * 20)));
    const [seg] = r.flush().segments;
    expect(seg!.windows.map((w) => w.t0 - T0)).toEqual([0, 5 * MIN, 10 * MIN]);
    expect(seg!.grid.cellM).toBe(5);
    const cells = seg!.grid.cells;
    expect(Object.keys(cells).sort()).toEqual(['0,0', '0,4']);
    expect(cells['0,0']! + cells['0,4']!).toBeCloseTo(12 * 60, 0);
  });

  it('starts a new segment when a device is reassigned, crediting history by time', () => {
    let now = T0;
    const r = new HistoryRecorder('summary', { now: () => now });
    r.setLinks(new Map([['D1', 'teamA']]));
    r.add(fix('D1', T0));
    r.add(fix('D1', T0 + MIN));
    now = T0 + MIN + 20_000;
    r.setLinks(new Map([['D1', 'teamB']]));
    r.add(fix('D1', T0 + 2 * MIN));
    const { segments } = r.flush();
    // teamA's last fix is credited the 20 s until the reassignment.
    expect(segments.map((s) => [s.teamId, s.endedAt])).toEqual([
      ['teamB', null],
      ['teamA', T0 + MIN + 20_000],
    ]);
    expect(segments[1]!.windows[0]!.secs).toBe(80);
    expect(segments[0]!.segmentId).toBe(`D1~teamB~${T0 + 2 * MIN}`);
  });

  it('credits the last fix at close, so a short segment still has a heat map', () => {
    let now = T0;
    const r = new HistoryRecorder('summary', { now: () => now });
    r.setLinks(new Map([['D1', 't1'], ['D2', 't2']]));
    r.add(fix('D1', T0));
    r.add(fix('D2', T0, north(50)));
    now = T0 + 25_000;
    r.closeAll(null);
    const segs = r.flush(true).segments;
    const d1 = segs.find((s) => s.deviceUid === 'D1')!;
    expect(d1.endedAt).toBe(T0 + 25_000);
    expect(d1.windows[0]!.secs).toBe(25);
    expect(Object.values(d1.grid.cells)).toEqual([25]);
    // Capped like any other gap, and an explicit end time wins.
    const late = new HistoryRecorder('summary', { now: () => T0 + 10 * MIN });
    late.setLinks(new Map([['D1', 't1']]));
    late.add(fix('D1', T0));
    late.closeAll(null);
    expect(late.flush(true).segments[0]!.windows[0]!.secs).toBe(60);
    const at = new HistoryRecorder('summary', { now: () => T0 + 10 * MIN });
    at.setLinks(new Map([['D1', 't1']]));
    at.add(fix('D1', T0));
    at.closeAll(T0 + 5_000);
    const [seg] = at.flush(true).segments;
    expect([seg!.endedAt, seg!.windows[0]!.secs]).toEqual([T0 + 5_000, 5]);
  });

  it('only writes segments that changed since the last flush', () => {
    const r = new HistoryRecorder('summary');
    r.setLinks(new Map([['D1', 't1'], ['D2', 't2']]));
    r.add(fix('D1', T0));
    r.add(fix('D2', T0));
    expect(r.flush().segments).toHaveLength(2);
    r.add(fix('D1', T0 + 5_000));
    expect(r.flush().segments.map((s) => s.deviceUid)).toEqual(['D1']);
    expect(r.flush().segments).toEqual([]);
  });

  it('keeps 15 s points only in Detailed mode while the team is on a call', () => {
    const r = new HistoryRecorder('detailed', { pointsPerChunk: 3 });
    r.setLinks(new Map([['D1', 't1']]));
    for (let t = 0; t < MIN; t += 5_000) r.add(fix('D1', T0 + t)); // not on a call: no points
    r.setOnCall(['t1']);
    for (let t = MIN; t < 3 * MIN; t += 5_000) r.add(fix('D1', T0 + t)); // 2 min on call: 8 points
    r.setOnCall([]);
    for (let t = 3 * MIN; t < 4 * MIN; t += 5_000) r.add(fix('D1', T0 + t));
    const mid = r.flush();
    expect(mid.points.map((c) => c.points.length)).toEqual([3, 3]); // full chunks only
    r.closeAll(null);
    const end = r.flush(true);
    expect(end.points.map((c) => [c.chunk, c.points.length])).toEqual([[2, 2]]);
    const summary = new HistoryRecorder('summary');
    summary.setLinks(new Map([['D1', 't1']]));
    summary.setOnCall(['t1']);
    summary.add(fix('D1', T0));
    expect(summary.flush(true).points).toEqual([]);
  });

  it('caps the grid and counts the overflow', () => {
    const r = new HistoryRecorder('summary', { maxCells: 3 });
    r.setLinks(new Map([['D1', 't1']]));
    for (let i = 0; i < 6; i++) r.add(fix('D1', T0 + i * 10_000, north(i * 10)));
    const [seg] = r.flush().segments;
    expect(Object.keys(seg!.grid.cells)).toHaveLength(3);
    expect(seg!.grid.overflowSecs).toBe(20);
  });

  it('stays within budget for an 8-hour, 20-device event (P5 acceptance)', () => {
    const r = new HistoryRecorder('summary');
    const sim = new Simulation({ devices: 20, startTime: T0, center });
    r.setLinks(new Map(sim.deviceUids.map((u, i) => [u, `team-${i}`])));
    let segmentWrites = 0;
    let maxDocBytes = 0;
    let maxCells = 0;
    for (let t = T0 + 5 * MIN; t <= T0 + 8 * 60 * MIN; t += 5 * MIN) {
      for (const f of sim.fixesBetween(t)) r.add(f);
      const { segments } = r.flush();
      segmentWrites += segments.length;
      for (const s of segments) {
        maxDocBytes = Math.max(maxDocBytes, Buffer.byteLength(JSON.stringify(s)));
        maxCells = Math.max(maxCells, Object.keys(s.grid.cells).length);
      }
    }
    r.closeAll(null);
    segmentWrites += r.flush(true).segments.length;
    // Budgets (plan.md, P5): one write per segment per 5 minutes, so at most
    // 12 per device-hour; a segment doc well under Firestore's 1 MiB limit.
    expect(segmentWrites / 20 / 8).toBeLessThanOrEqual(12.2);
    expect(maxDocBytes).toBeLessThan(256 * 1024);
    expect(maxCells).toBeLessThanOrEqual(5_000);
    console.info(`history budget: ${segmentWrites} segment writes, max doc ${(maxDocBytes / 1024).toFixed(1)} KiB, max cells ${maxCells}`);
  });
});
