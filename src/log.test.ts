// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { createLogger } from './log.js';

describe('createLogger', () => {
  it('writes one JSON object per line and drops levels below the threshold', () => {
    const lines: string[] = [];
    const log = createLogger('info', (line) => lines.push(line));
    log.debug('hidden');
    log.info('shown', { deviceCount: 3 });
    log.error('also shown');

    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first).toMatchObject({ level: 'info', msg: 'shown', deviceCount: 3 });
    expect(typeof first.time).toBe('string');
    expect(JSON.parse(lines[1]!).level).toBe('error');
  });
});
