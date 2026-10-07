// SPDX-License-Identifier: AGPL-3.0-only

import type { HistoryMode } from '../backend/types.js';
import type { DevicePosition } from '../sources/types.js';

/**
 * Location history for one event, aggregated in memory from the full-rate
 * position stream (data contract, "Shapes"):
 *
 * - One segment per continuous (device, team) pairing. Reassigning or
 *   unlinking a device closes its segment; history is credited by time.
 * - Each fix is credited with the time until the device's next fix, capped
 *   at maxGapMs, so a device that goes quiet doesn't pile up time.
 * - 5-minute windows hold the time-weighted mean position, the RMS spread
 *   around it, the fix count and the seconds covered.
 * - A sparse grid of about 5 m cells holds seconds spent per cell, as a heat
 *   map. It is capped at maxCells; seconds beyond the cap are counted in
 *   grid.overflowSecs rather than dropped silently.
 * - In Detailed mode, a point every 15 s while the team is on a call.
 */

export interface HistoryWindow {
  t0: number;
  lat: number;
  lon: number;
  spreadM: number;
  n: number;
  secs: number;
}

export interface HistorySegmentDoc {
  segmentId: string;
  deviceUid: string;
  teamId: string;
  startedAt: number;
  endedAt: number | null;
  windows: HistoryWindow[];
  grid: { cellM: number; originLat: number; originLon: number; cells: Record<string, number>; overflowSecs: number };
}

export interface HistoryPoint {
  t: number;
  lat: number;
  lon: number;
  ce?: number;
}

export interface PointsChunk {
  segmentId: string;
  chunk: number;
  points: HistoryPoint[];
}

export interface RecorderOptions {
  windowMs?: number;
  cellM?: number;
  maxGapMs?: number;
  maxCells?: number;
  pointIntervalMs?: number;
  pointsPerChunk?: number;
  /** Clock for closing a segment without an explicit end time (the bridge's time, epoch ms). */
  now?: () => number;
}

interface WindowAcc {
  t0: number;
  w: number;
  sumE: number;
  sumN: number;
  sumR2: number;
  n: number;
  // Unweighted fallback, for a window whose only fix hasn't been credited time yet.
  uE: number;
  uN: number;
}

interface Segment {
  id: string;
  deviceUid: string;
  teamId: string;
  startedAt: number;
  endedAt: number | null;
  origin: { lat: number; lon: number };
  windows: Map<number, WindowAcc>;
  cells: Map<string, number>;
  overflowSecs: number;
  last: { t: number; e: number; n: number } | null;
  dirty: boolean;
  points: HistoryPoint[];
  chunk: number;
  lastPointAt: number;
}

const R = 6_371_008.8;
const M_PER_DEG = (R * Math.PI) / 180;

export class HistoryRecorder {
  private mode: HistoryMode;
  private links = new Map<string, string>();
  private onCall = new Set<string>();
  /** Open segment per device. */
  private open = new Map<string, Segment>();
  /** Closed segments not yet flushed. */
  private closed: Segment[] = [];
  private readonly o: Required<RecorderOptions>;

  constructor(mode: HistoryMode, options: RecorderOptions = {}) {
    this.mode = mode;
    this.o = {
      windowMs: 5 * 60_000,
      cellM: 5,
      maxGapMs: 60_000,
      maxCells: 5_000,
      pointIntervalMs: 15_000,
      pointsPerChunk: 500,
      now: Date.now,
      ...options,
    };
  }

  setMode(mode: HistoryMode): void {
    this.mode = mode;
    if (mode === 'off') this.closeAll(null);
  }

  /** Current device -> team links. Changed or removed links close the device's segment. */
  setLinks(links: Map<string, string>): void {
    this.links = new Map(links);
    for (const [deviceUid, seg] of this.open) {
      if (this.links.get(deviceUid) !== seg.teamId) this.close(deviceUid, null);
    }
  }

  setOnCall(teamIds: Iterable<string>): void {
    this.onCall = new Set(teamIds);
  }

  add(p: DevicePosition): void {
    if (this.mode === 'off') return;
    const teamId = this.links.get(p.deviceUid);
    if (!teamId) return;
    const t = p.deviceTime;

    let seg = this.open.get(p.deviceUid);
    if (seg && seg.teamId !== teamId) {
      this.close(p.deviceUid, null);
      seg = undefined;
    }
    if (!seg) {
      seg = {
        id: `${p.deviceUid}~${teamId}~${t}`,
        deviceUid: p.deviceUid,
        teamId,
        startedAt: t,
        endedAt: null,
        origin: { lat: p.lat, lon: p.lon },
        windows: new Map(),
        cells: new Map(),
        overflowSecs: 0,
        last: null,
        dirty: true,
        points: [],
        chunk: 0,
        lastPointAt: -Infinity,
      };
      this.open.set(p.deviceUid, seg);
    }
    if (seg.last && t <= seg.last.t) return; // out of order or duplicate

    const e = (p.lon - seg.origin.lon) * M_PER_DEG * Math.cos((seg.origin.lat * Math.PI) / 180);
    const n = (p.lat - seg.origin.lat) * M_PER_DEG;

    // Credit the previous fix with the time until this one.
    if (seg.last) this.credit(seg, seg.last, Math.min(t - seg.last.t, this.o.maxGapMs));
    seg.last = { t, e, n };

    const win = this.windowFor(seg, t);
    win.n++;
    win.uE += e;
    win.uN += n;
    seg.dirty = true;

    if (this.mode === 'detailed' && this.onCall.has(teamId) && t - seg.lastPointAt >= this.o.pointIntervalMs) {
      seg.lastPointAt = t;
      seg.points.push({ t, lat: p.lat, lon: p.lon, ...(p.ce !== undefined ? { ce: p.ce } : {}) });
    }
  }

  /**
   * Closes every open segment, e.g. at event close. Without `at`, each segment
   * ends at its last fix plus the time credited to it (see close).
   */
  closeAll(at: number | null): void {
    for (const deviceUid of [...this.open.keys()]) this.close(deviceUid, at);
  }

  /** Segments changed since the last flush, plus full point chunks (all remaining points when final). */
  flush(final = false): { segments: HistorySegmentDoc[]; points: PointsChunk[] } {
    const segments: HistorySegmentDoc[] = [];
    const points: PointsChunk[] = [];
    for (const seg of [...this.open.values(), ...this.closed]) {
      if (seg.dirty) {
        segments.push(this.toDoc(seg));
        seg.dirty = false;
      }
      while (seg.points.length >= this.o.pointsPerChunk || (final || seg.endedAt !== null) && seg.points.length > 0) {
        points.push({ segmentId: seg.id, chunk: seg.chunk++, points: seg.points.splice(0, this.o.pointsPerChunk) });
      }
    }
    this.closed = [];
    return { segments, points };
  }

  get openSegmentCount(): number {
    return this.open.size;
  }

  /**
   * Ends a segment. Its last fix has no next fix to measure against, so it is
   * credited the time until the end (`at`, or now), capped like any other
   * gap. Without this, a segment's final position, and a segment with a
   * single position, would count for nothing.
   */
  private close(deviceUid: string, at: number | null): void {
    const seg = this.open.get(deviceUid);
    if (!seg) return;
    let end = at ?? seg.startedAt;
    if (seg.last) {
      const dt = Math.min(Math.max(0, (at ?? this.o.now()) - seg.last.t), this.o.maxGapMs);
      this.credit(seg, seg.last, dt);
      end = at ?? seg.last.t + dt;
    }
    seg.endedAt = end;
    seg.dirty = true;
    this.open.delete(deviceUid);
    this.closed.push(seg);
  }

  private windowFor(seg: Segment, t: number): WindowAcc {
    const t0 = Math.floor(t / this.o.windowMs) * this.o.windowMs;
    let w = seg.windows.get(t0);
    if (!w) {
      w = { t0, w: 0, sumE: 0, sumN: 0, sumR2: 0, n: 0, uE: 0, uN: 0 };
      seg.windows.set(t0, w);
    }
    return w;
  }

  private credit(seg: Segment, at: { t: number; e: number; n: number }, dtMs: number): void {
    if (dtMs <= 0) return;
    const secs = dtMs / 1000;
    const w = this.windowFor(seg, at.t);
    w.w += secs;
    w.sumE += secs * at.e;
    w.sumN += secs * at.n;
    w.sumR2 += secs * (at.e * at.e + at.n * at.n);

    const key = `${Math.floor(at.e / this.o.cellM)},${Math.floor(at.n / this.o.cellM)}`;
    const existing = seg.cells.get(key);
    if (existing !== undefined) seg.cells.set(key, existing + secs);
    else if (seg.cells.size < this.o.maxCells) seg.cells.set(key, secs);
    else seg.overflowSecs += secs;
  }

  private toDoc(seg: Segment): HistorySegmentDoc {
    const cosLat = Math.cos((seg.origin.lat * Math.PI) / 180);
    const toLatLon = (e: number, n: number) => ({
      lat: seg.origin.lat + n / M_PER_DEG,
      lon: seg.origin.lon + e / (M_PER_DEG * cosLat),
    });
    const windows = [...seg.windows.values()]
      .sort((a, b) => a.t0 - b.t0)
      .map((w): HistoryWindow => {
        const weighted = w.w > 0;
        const meanE = weighted ? w.sumE / w.w : w.uE / Math.max(1, w.n);
        const meanN = weighted ? w.sumN / w.w : w.uN / Math.max(1, w.n);
        const spread = weighted ? Math.sqrt(Math.max(0, w.sumR2 / w.w - (meanE * meanE + meanN * meanN))) : 0;
        const { lat, lon } = toLatLon(meanE, meanN);
        return { t0: w.t0, lat: round(lat, 7), lon: round(lon, 7), spreadM: round(spread, 1), n: w.n, secs: round(w.w, 1) };
      });
    return {
      segmentId: seg.id,
      deviceUid: seg.deviceUid,
      teamId: seg.teamId,
      startedAt: seg.startedAt,
      endedAt: seg.endedAt,
      windows,
      grid: {
        cellM: this.o.cellM,
        originLat: seg.origin.lat,
        originLon: seg.origin.lon,
        cells: Object.fromEntries([...seg.cells].map(([k, v]) => [k, round(v, 1)])),
        overflowSecs: round(seg.overflowSecs, 1),
      },
    };
  }
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
