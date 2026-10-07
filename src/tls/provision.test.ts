// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TakConfig } from '../config.js';
import { createLogger } from '../log.js';

type LogRecord = { level: string; msg: string };
const collect = (into: LogRecord[]) => (line: string) => into.push(JSON.parse(line) as LogRecord);
import { EnrollmentError, loadEnrollment, saveEnrollment, type EnrolledIdentity, type EnrollOptions } from './enroll.js';
import { RENEW_WITHIN_MS, clientUidFor, provisionIdentity, scheduleRenewal } from './provision.js';

const DAY = 24 * 3600_000;
const NOW = 1_800_000_000_000;

const tak = (over: Partial<TakConfig> = {}): TakConfig => ({
  host: 'takserver.example.org',
  streamPort: 8089,
  apiPort: 8443,
  enroll: { host: 'takserver.example.org', port: 8446, username: 'bridge', password: 'pw' },
  ...over,
});

const identity = (over: Partial<EnrolledIdentity> = {}): EnrolledIdentity => ({
  keyPem: 'KEY',
  certPem: 'CERT',
  caPems: ['CA'],
  notAfter: NOW + 365 * DAY,
  host: 'takserver.example.org',
  username: 'bridge',
  enrolledAt: NOW,
  ...over,
});

describe('provisionIdentity', () => {
  let dir: string;
  let records: LogRecord[];
  const log = () => createLogger('debug', collect(records));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-provision-'));
    records = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('enrolls on first start and saves the result', async () => {
    const enroll = vi.fn(async (_o: EnrollOptions) => identity());
    const out = await provisionIdentity(tak(), dir, log(), { enroll, now: () => NOW });
    expect(out.freshlyEnrolled).toBe(true);
    expect(out.identity).toMatchObject({ kind: 'pem', key: 'KEY', cert: 'CERT', ca: ['CA'] });
    expect(enroll.mock.calls[0]![0]).toMatchObject({ host: 'takserver.example.org', port: 8446, username: 'bridge', clientUid: clientUidFor('bridge') });
    expect(loadEnrollment(dir)?.certPem).toBe('CERT');
    expect(JSON.stringify(records)).not.toContain('pw');
    expect(JSON.stringify(records)).not.toContain('KEY');
  });

  it('reuses a saved certificate', async () => {
    saveEnrollment(dir, identity());
    const enroll = vi.fn();
    const out = await provisionIdentity(tak(), dir, log(), { enroll, now: () => NOW });
    expect(enroll).not.toHaveBeenCalled();
    expect(out.freshlyEnrolled).toBe(false);
  });

  it('enrolls again for a different user, or near expiry', async () => {
    saveEnrollment(dir, identity({ username: 'someone-else' }));
    const enroll = vi.fn(async () => identity());
    await provisionIdentity(tak(), dir, log(), { enroll, now: () => NOW });
    saveEnrollment(dir, identity({ notAfter: NOW + RENEW_WITHIN_MS - DAY }));
    await provisionIdentity(tak(), dir, log(), { enroll, now: () => NOW });
    expect(enroll).toHaveBeenCalledTimes(2);
  });

  it('keeps using a near-expiry certificate if renewal fails', async () => {
    saveEnrollment(dir, identity({ notAfter: NOW + DAY }));
    const enroll = vi.fn(async () => {
      throw new EnrollmentError('refused', 401);
    });
    const out = await provisionIdentity(tak(), dir, log(), { enroll, now: () => NOW });
    expect(out.enrolled?.notAfter).toBe(NOW + DAY);
    expect(records.some((r) => r.level === 'warn' && /could not renew/.test(r.msg))).toBe(true);
  });

  it('fails clearly with no saved certificate and no .p12', async () => {
    const enroll = vi.fn(async () => {
      throw new EnrollmentError('TAK Server refused the username or password', 401);
    });
    await expect(provisionIdentity(tak(), dir, log(), { enroll, now: () => NOW })).rejects.toThrow(/refused/);
  });

  it('falls back to TAK_CLIENT_P12 when enrollment fails', async () => {
    const enroll = vi.fn(async () => {
      throw new EnrollmentError('nope');
    });
    const out = await provisionIdentity(tak({ clientP12Path: '/x.p12', clientP12Password: 'p' }), dir, log(), {
      enroll,
      now: () => NOW,
      readFile: () => {
        throw new Error('missing');
      },
    }).catch((e: Error) => e);
    // The .p12 path was tried (and here, deliberately, can't be read).
    expect((out as Error).message).toMatch(/Cannot read the client certificate bundle/);
  });

  it('uses the .p12 directly when enrollment is not configured', async () => {
    const out = await provisionIdentity(tak({ enroll: undefined, clientP12Path: '/x.p12' }), dir, log(), {
      readFile: () => {
        throw new Error('missing');
      },
    }).catch((e: Error) => e);
    expect((out as Error).message).toMatch(/Cannot read the client certificate bundle/);
  });
});

describe('scheduleRenewal', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-renew-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('does nothing while the certificate is far from expiry', async () => {
    const enroll = vi.fn();
    const stop = scheduleRenewal(tak(), dir, createLogger('error', () => {}), identity(), () => {}, { enroll, now: () => NOW, checkEveryMs: 10 });
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(enroll).not.toHaveBeenCalled();
  });

  it('renews near expiry, saves, and hands over the new identity', async () => {
    const enroll = vi.fn(async () => identity({ certPem: 'NEW', notAfter: NOW + 365 * DAY }));
    const onRenewed = vi.fn();
    const stop = scheduleRenewal(tak(), dir, createLogger('error', () => {}), identity({ notAfter: NOW + DAY }), onRenewed, {
      enroll,
      now: () => NOW,
      checkEveryMs: 10,
    });
    await flush();
    await flush();
    await new Promise((r) => setTimeout(r, 50));
    stop();
    expect(enroll).toHaveBeenCalledTimes(1); // the new certificate is far from expiry, so no more renewals
    expect(onRenewed.mock.calls[0]![0]).toMatchObject({ cert: 'NEW' });
    expect(loadEnrollment(dir)?.certPem).toBe('NEW');
  });

  it('explains a refused renewal (e.g. a one-time token)', async () => {
    const records: LogRecord[] = [];
    const enroll = vi.fn(async () => {
      throw new EnrollmentError('refused', 401);
    });
    const stop = scheduleRenewal(tak(), dir, createLogger('warn', collect(records)), identity({ notAfter: NOW + DAY }), () => {}, {
      enroll,
      now: () => NOW,
      checkEveryMs: 60_000,
    });
    await flush();
    await flush();
    stop();
    expect(records[0]?.msg).toMatch(/one-time Enroll QR token/);
  });
});
