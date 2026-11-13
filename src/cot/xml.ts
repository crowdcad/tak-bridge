// SPDX-License-Identifier: AGPL-3.0-only

import { XMLParser } from 'fast-xml-parser';
import type { DevicePosition } from '../sources/types.js';

/**
 * CoT parsing and building.
 *
 * Only `a-*` (atoms: people, units, vehicles) events are device positions.
 * Map pins (`b-m-p-*`), chat (`b-t-*`), tasking (`t-*`) and everything else
 * are not, even when they carry a point: chat and tasking use a 0,0
 * placeholder, and a pin is where someone tapped, not where a device is.
 */

export type ParsedCot =
  | { kind: 'position'; position: DevicePosition }
  | { kind: 'ignored'; type: string; reason: string }
  | { kind: 'invalid'; reason: string };

/** TAK's "unknown" value for hae, ce and le. */
const UNKNOWN = 9_999_999;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: true,
  htmlEntities: false,
});

type Attrs = Record<string, unknown>;

function attr(node: unknown, name: string): string | undefined {
  if (node && typeof node === 'object' && name in node) {
    const v = (node as Attrs)[name];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function known(value: number | undefined): number | undefined {
  return value === undefined || Math.abs(value) >= UNKNOWN ? undefined : value;
}

export function parseCot(xml: string, receivedAt: number = Date.now()): ParsedCot {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return { kind: 'invalid', reason: 'not well-formed XML' };
  }
  const event = (doc as Attrs | undefined)?.event;
  if (!event || typeof event !== 'object') return { kind: 'invalid', reason: 'no <event> element' };

  const type = attr(event, 'type') ?? '';
  const uid = attr(event, 'uid');
  if (!uid) return { kind: 'invalid', reason: 'event has no uid' };
  if (!type.startsWith('a-')) return { kind: 'ignored', type, reason: 'not a position (a-*) event' };

  const point = (event as Attrs).point;
  const lat = num(attr(point, 'lat'));
  const lon = num(attr(point, 'lon'));
  if (lat === undefined || lon === undefined) return { kind: 'invalid', reason: 'missing point lat/lon' };
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return { kind: 'invalid', reason: 'lat/lon out of range' };
  if (lat === 0 && lon === 0) return { kind: 'ignored', type, reason: '0,0 placeholder point' };

  const time = Date.parse(attr(event, 'time') ?? '');
  const detail = (event as Attrs).detail;
  const contact = detail && typeof detail === 'object' ? (detail as Attrs).contact : undefined;
  const track = detail && typeof detail === 'object' ? (detail as Attrs).track : undefined;

  const position: DevicePosition = {
    deviceUid: uid,
    cotType: type,
    lat,
    lon,
    deviceTime: Number.isFinite(time) ? time : receivedAt,
    receivedAt,
  };
  const callsign = attr(contact, 'callsign');
  if (callsign) position.callsign = callsign;
  const hae = known(num(attr(point, 'hae')));
  if (hae !== undefined) position.hae = hae;
  const ce = known(num(attr(point, 'ce')));
  if (ce !== undefined) position.ce = ce;
  const course = num(attr(track, 'course'));
  if (course !== undefined) position.course = course;
  const speed = num(attr(track, 'speed'));
  if (speed !== undefined) position.speed = speed;

  return { kind: 'position', position };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Builds a position CoT event, as a TAK client would send its own location. */
export function buildPositionCot(p: {
  uid: string;
  callsign?: string;
  type?: string;
  lat: number;
  lon: number;
  hae?: number;
  ce?: number;
  course?: number;
  speed?: number;
  time: number;
  staleSeconds?: number;
}): string {
  const stale = p.time + (p.staleSeconds ?? 120) * 1000;
  const contact = p.callsign ? `<contact callsign="${esc(p.callsign)}" endpoint="*:-1:stcp"/>` : '';
  const track =
    p.course !== undefined || p.speed !== undefined
      ? `<track course="${(p.course ?? 0).toFixed(1)}" speed="${(p.speed ?? 0).toFixed(2)}"/>`
      : '';
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${esc(p.uid)}" type="${esc(p.type ?? 'a-f-G-U-C')}" ` +
    `time="${iso(p.time)}" start="${iso(p.time)}" stale="${iso(stale)}" how="m-g">` +
    `<point lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}" hae="${(p.hae ?? UNKNOWN).toFixed(1)}" ` +
    `ce="${(p.ce ?? UNKNOWN).toFixed(1)}" le="${UNKNOWN.toFixed(1)}"/>` +
    `<detail>${contact}${track}</detail></event>`
  );
}

/** Builds a non-position CoT event with a point, for exercising filters. */
export function buildOtherCot(p: { uid: string; type: string; lat?: number; lon?: number; time: number }): string {
  return (
    `<event version="2.0" uid="${esc(p.uid)}" type="${esc(p.type)}" time="${iso(p.time)}" ` +
    `start="${iso(p.time)}" stale="${iso(p.time + 60_000)}" how="h-g-i-g-o">` +
    `<point lat="${(p.lat ?? 0).toFixed(7)}" lon="${(p.lon ?? 0).toFixed(7)}" hae="${UNKNOWN.toFixed(1)}" ` +
    `ce="${UNKNOWN.toFixed(1)}" le="${UNKNOWN.toFixed(1)}"/><detail/></event>`
  );
}

/** TAK keepalive ping a client sends; TAK Server answers with t-x-c-t-r. */
export function buildPing(uid: string, time: number = Date.now()): string {
  return buildOtherCot({ uid: `${uid}-ping`, type: 't-x-c-t', time });
}
