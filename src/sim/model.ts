// SPDX-License-Identifier: AGPL-3.0-only

import type { DevicePosition } from '../sources/types.js';

/**
 * Synthetic TAK devices for tests and local development.
 *
 * Each device dwells at a post, walks to another post at walking speed, and
 * repeats. It reports a position every reportIntervalMs, with GPS noise. The
 * simulation runs on a virtual clock, so `fixesBetween` can produce an 8-hour,
 * 20-device event in well under a second for budget tests, while SimTakServer
 * replays it in real or compressed time over a socket.
 *
 * Everything is driven by a seeded PRNG, so the same options always produce
 * the same fixes.
 */

export interface SimOptions {
  devices: number;
  startTime: number;
  /** Center of the venue. */
  center: { lat: number; lon: number };
  /** Posts are placed within this radius of the center, in meters. */
  radiusM?: number;
  /** Number of posts to move between. */
  posts?: number;
  reportIntervalMs?: number;
  /** Dwell time range at a post, in ms. */
  dwellMs?: [number, number];
  /** Walking speed, in m/s. */
  speedMps?: number;
  /** Standard deviation of GPS noise, in meters. */
  noiseM?: number;
  seed?: number;
  /** Callsign for device i (0-based). Defaults to "Team 1", "Team 2", ... */
  callsign?: (i: number) => string;
}

interface DeviceState {
  uid: string;
  callsign: string;
  /** Current position in local meters east/north of center. */
  x: number;
  y: number;
  target: { x: number; y: number } | null;
  dwellUntil: number;
  nextReport: number;
  course: number;
  speed: number;
}

/** mulberry32: small, fast, deterministic PRNG. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const M_PER_DEG_LAT = 111_320;

export function metersToLatLon(center: { lat: number; lon: number }, x: number, y: number) {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180);
  return { lat: center.lat + y / M_PER_DEG_LAT, lon: center.lon + x / mPerDegLon };
}

export class Simulation {
  readonly options: Required<Omit<SimOptions, 'callsign'>> & Pick<SimOptions, 'callsign'>;
  readonly posts: { x: number; y: number }[];
  private readonly rand: () => number;
  private readonly devices: DeviceState[];
  private clock: number;

  constructor(options: SimOptions) {
    this.options = {
      radiusM: 400,
      posts: 12,
      reportIntervalMs: 5_000,
      dwellMs: [5 * 60_000, 30 * 60_000],
      speedMps: 1.3,
      noiseM: 3,
      seed: 1,
      ...options,
    };
    this.rand = prng(this.options.seed);
    this.clock = this.options.startTime;

    this.posts = Array.from({ length: this.options.posts }, () => {
      const r = this.options.radiusM * Math.sqrt(this.rand());
      const a = this.rand() * 2 * Math.PI;
      return { x: r * Math.cos(a), y: r * Math.sin(a) };
    });

    this.devices = Array.from({ length: this.options.devices }, (_, i) => {
      const post = this.posts[i % this.posts.length]!;
      return {
        uid: `SIM-${String(i + 1).padStart(3, '0')}`,
        callsign: this.options.callsign ? this.options.callsign(i) : `Team ${i + 1}`,
        x: post.x,
        y: post.y,
        target: null,
        dwellUntil: this.options.startTime + this.dwell(),
        // Stagger reports so devices don't all report on the same millisecond.
        nextReport: this.options.startTime + Math.floor(this.rand() * this.options.reportIntervalMs),
        course: 0,
        speed: 0,
      };
    });
  }

  get now(): number {
    return this.clock;
  }

  get deviceUids(): string[] {
    return this.devices.map((d) => d.uid);
  }

  /** Advances the virtual clock to `until` and returns every fix reported on the way, in time order. */
  fixesBetween(until: number): DevicePosition[] {
    const fixes: DevicePosition[] = [];
    for (;;) {
      // The next device to report, by time.
      let next: DeviceState | undefined;
      for (const d of this.devices) if (!next || d.nextReport < next.nextReport) next = d;
      if (!next || next.nextReport > until) break;

      const t = next.nextReport;
      this.step(next, t);
      fixes.push(this.report(next, t));
      next.nextReport = t + this.options.reportIntervalMs;
    }
    this.clock = Math.max(this.clock, until);
    return fixes;
  }

  private dwell(): number {
    const [lo, hi] = this.options.dwellMs;
    return lo + this.rand() * (hi - lo);
  }

  /** Moves a device from its last report to time t. */
  private step(d: DeviceState, t: number): void {
    const dt = this.options.reportIntervalMs / 1000;
    if (!d.target) {
      d.speed = 0;
      if (t >= d.dwellUntil) {
        d.target = this.posts[Math.floor(this.rand() * this.posts.length)]!;
      }
      return;
    }
    const dx = d.target.x - d.x;
    const dy = d.target.y - d.y;
    const dist = Math.hypot(dx, dy);
    const stepM = this.options.speedMps * dt;
    if (dist <= stepM) {
      d.x = d.target.x;
      d.y = d.target.y;
      d.target = null;
      d.speed = 0;
      d.dwellUntil = t + this.dwell();
    } else {
      d.x += (dx / dist) * stepM;
      d.y += (dy / dist) * stepM;
      d.speed = this.options.speedMps;
      d.course = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
    }
  }

  private gaussian(): number {
    // Box-Muller
    const u = 1 - this.rand();
    const v = this.rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  private report(d: DeviceState, t: number): DevicePosition {
    const n = this.options.noiseM;
    const { lat, lon } = metersToLatLon(this.options.center, d.x + this.gaussian() * n, d.y + this.gaussian() * n);
    return {
      deviceUid: d.uid,
      callsign: d.callsign,
      cotType: 'a-f-G-U-C',
      lat,
      lon,
      ce: Math.round(n * 2 * 10) / 10,
      course: d.course,
      speed: d.speed,
      deviceTime: t,
      receivedAt: t,
    };
  }
}
