// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { Simulation } from './model.js';

const center = { lat: 37.8715, lon: -122.273 };
const start = Date.parse('2026-10-07T08:00:00Z');
const HOUR = 3_600_000;

function metersBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lon - b.lon) * 111_320 * Math.cos((center.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

describe('Simulation', () => {
  it('is deterministic for a given seed', () => {
    const run = () => new Simulation({ devices: 3, startTime: start, center, seed: 42 }).fixesBetween(start + 600_000);
    expect(run()).toEqual(run());
    const other = new Simulation({ devices: 3, startTime: start, center, seed: 43 }).fixesBetween(start + 600_000);
    expect(other).not.toEqual(run());
  });

  it('produces an 8-hour, 20-device event in compressed time', () => {
    const sim = new Simulation({ devices: 20, startTime: start, center });
    const t0 = performance.now();
    const fixes = sim.fixesBetween(start + 8 * HOUR);
    const elapsedMs = performance.now() - t0;

    // One fix per device per 5 s, give or take the staggered first report.
    expect(fixes.length).toBeGreaterThanOrEqual(20 * (8 * 720 - 1));
    expect(fixes.length).toBeLessThanOrEqual(20 * 8 * 720);
    expect(elapsedMs).toBeLessThan(5_000);

    // Time-ordered, within the window, and every device reports.
    for (let i = 1; i < fixes.length; i++) expect(fixes[i]!.deviceTime).toBeGreaterThanOrEqual(fixes[i - 1]!.deviceTime);
    expect(fixes[0]!.deviceTime).toBeGreaterThanOrEqual(start);
    expect(fixes.at(-1)!.deviceTime).toBeLessThanOrEqual(start + 8 * HOUR);
    expect(new Set(fixes.map((f) => f.deviceUid)).size).toBe(20);
  });

  it('keeps devices near the venue and moves them at walking speed', () => {
    const sim = new Simulation({ devices: 5, startTime: start, center, radiusM: 300, noiseM: 0 });
    const fixes = sim.fixesBetween(start + 2 * HOUR);
    for (const f of fixes) expect(metersBetween(f, center)).toBeLessThan(301);

    const byDevice = new Map<string, typeof fixes>();
    for (const f of fixes) byDevice.set(f.deviceUid, [...(byDevice.get(f.deviceUid) ?? []), f]);
    let moved = false;
    for (const series of byDevice.values()) {
      for (let i = 1; i < series.length; i++) {
        const d = metersBetween(series[i]!, series[i - 1]!);
        expect(d).toBeLessThanOrEqual(1.3 * 5 + 0.01); // never faster than walking
        if (d > 0) moved = true;
      }
    }
    expect(moved).toBe(true);
  });

  it('continues across calls without repeating or skipping fixes', () => {
    const whole = new Simulation({ devices: 4, startTime: start, center }).fixesBetween(start + HOUR);
    const split = new Simulation({ devices: 4, startTime: start, center });
    const parts = [...split.fixesBetween(start + HOUR / 3), ...split.fixesBetween(start + HOUR)];
    expect(parts).toEqual(whole);
  });

  it('uses Team N callsigns by default and accepts custom ones', () => {
    const def = new Simulation({ devices: 2, startTime: start, center }).fixesBetween(start + 10_000);
    expect(new Set(def.map((f) => f.callsign))).toEqual(new Set(['Team 1', 'Team 2']));
    const custom = new Simulation({ devices: 1, startTime: start, center, callsign: () => 'Unit A' }).fixesBetween(start + 10_000);
    expect(custom[0]!.callsign).toBe('Unit A');
  });
});
