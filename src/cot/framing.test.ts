// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { CotFramer } from './framing.js';
import { buildPositionCot } from './xml.js';

const a = buildPositionCot({ uid: 'A', callsign: 'Team 1', lat: 37.87, lon: -122.27, time: 0 });
const b = buildPositionCot({ uid: 'B', callsign: 'Team 2', lat: 37.88, lon: -122.26, time: 1000 });
const strip = (s: string) => s.replace(/^<\?xml[^>]*\?>/, '');

describe('CotFramer', () => {
  it('returns each event from concatenated messages in one chunk', () => {
    const events = new CotFramer().push(a + b);
    expect(events).toEqual([strip(a), strip(b)]);
  });

  it('reassembles events split at every possible byte boundary', () => {
    const stream = a + b;
    for (let cut = 1; cut < stream.length; cut++) {
      const framer = new CotFramer();
      const events = [...framer.push(stream.slice(0, cut)), ...framer.push(stream.slice(cut))];
      expect(events).toEqual([strip(a), strip(b)]);
    }
  });

  it('handles one byte at a time', () => {
    const framer = new CotFramer();
    const events: string[] = [];
    for (const ch of a + b) events.push(...framer.push(ch));
    expect(events).toEqual([strip(a), strip(b)]);
  });

  it('accepts self-closing events and skips garbage between events', () => {
    const framer = new CotFramer();
    const events = framer.push('noise<events/>junk<event uid="x" type="t-x-c-t-r"/>more' + a);
    expect(events).toEqual(['<event uid="x" type="t-x-c-t-r"/>', strip(a)]);
    expect(framer.discarded).toBeGreaterThan(0);
  });

  it('drops an oversized partial event and resyncs on the next one', () => {
    const framer = new CotFramer(200);
    expect(framer.push('<event uid="huge"><detail>' + 'x'.repeat(500))).toEqual([]);
    expect(framer.push(a)).toEqual([strip(a)]);
  });
});
