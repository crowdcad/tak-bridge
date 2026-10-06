// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildOtherCot, buildPing, buildPositionCot, parseCot } from './xml.js';

const t = Date.parse('2026-10-07T12:00:00Z');

describe('parseCot', () => {
  it('parses a position with callsign, accuracy and track', () => {
    const xml = buildPositionCot({
      uid: 'ANDROID-123',
      callsign: 'Medic 1 & Co',
      lat: 37.8715,
      lon: -122.273,
      hae: 52,
      ce: 4.5,
      course: 90,
      speed: 1.3,
      time: t,
    });
    const parsed = parseCot(xml, t + 500);
    expect(parsed).toEqual({
      kind: 'position',
      position: {
        deviceUid: 'ANDROID-123',
        callsign: 'Medic 1 & Co',
        cotType: 'a-f-G-U-C',
        lat: 37.8715,
        lon: -122.273,
        hae: 52,
        ce: 4.5,
        course: 90,
        speed: 1.3,
        deviceTime: t,
        receivedAt: t + 500,
      },
    });
  });

  it('treats TAK unknown values (9999999) as missing', () => {
    const parsed = parseCot(buildPositionCot({ uid: 'X', lat: 1, lon: 2, time: t }));
    expect(parsed.kind).toBe('position');
    if (parsed.kind === 'position') {
      expect(parsed.position.hae).toBeUndefined();
      expect(parsed.position.ce).toBeUndefined();
      expect(parsed.position.callsign).toBeUndefined();
    }
  });

  it.each([
    ['map pin', 'b-m-p-s-p-i'],
    ['GeoChat', 'b-t-f'],
    ['delete task', 't-x-d-d'],
    ['ping reply', 't-x-c-t-r'],
  ])('ignores a %s even when it carries a point', (_name, type) => {
    const parsed = parseCot(buildOtherCot({ uid: 'u', type, lat: 37.87, lon: -122.27, time: t }));
    expect(parsed).toMatchObject({ kind: 'ignored', type });
  });

  it('ignores an a-* event at the 0,0 placeholder', () => {
    expect(parseCot(buildPositionCot({ uid: 'z', lat: 0, lon: 0, time: t }))).toMatchObject({ kind: 'ignored' });
  });

  it.each([
    ['malformed XML', '<event uid="x" type="a-f"><point lat='],
    ['no event element', '<auth/>'],
    ['no uid', '<event type="a-f-G"><point lat="1" lon="2"/></event>'],
    ['missing lat', '<event uid="x" type="a-f-G"><point lon="2"/></event>'],
    ['out of range', '<event uid="x" type="a-f-G"><point lat="91" lon="2"/></event>'],
  ])('rejects %s', (_name, xml) => {
    expect(parseCot(xml).kind).toBe('invalid');
  });

  it('falls back to receive time when the event time is unparseable', () => {
    const parsed = parseCot('<event uid="x" type="a-f-G" time="soon"><point lat="1" lon="2"/></event>', 42);
    expect(parsed.kind === 'position' && parsed.position.deviceTime).toBe(42);
  });

  it('builds a ping that is not a position', () => {
    expect(parseCot(buildPing('bridge'))).toMatchObject({ kind: 'ignored', type: 't-x-c-t' });
  });
});
