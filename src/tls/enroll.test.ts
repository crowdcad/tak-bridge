// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { Simulation } from '../sim/model.js';
import { SimTakServer } from '../sim/server.js';
import { CotStreamSource } from '../sources/cot-stream.js';
import type { DevicePosition } from '../sources/types.js';
import { generateDevCerts, hasOpenssl, type DevCerts } from '../testing/certs.js';
import { FakeEnrollServer } from '../testing/enroll-server.js';
import {
  EnrollmentError,
  buildCsr,
  enroll,
  enrollmentUsable,
  loadEnrollment,
  parseEnrollLink,
  parseSignResponse,
  parseTlsConfig,
  saveEnrollment,
  type EnrolledIdentity,
} from './enroll.js';
import { identityFromEnrollment } from './identity.js';

const log = createLogger('error', () => {});

describe('parseEnrollLink', () => {
  it('reads an Enroll QR link', () => {
    expect(parseEnrollLink('tak://com.atakmap.app/enroll?host=takserver.example.org&username=bridge&token=t0k')).toEqual({
      host: 'takserver.example.org',
      username: 'bridge',
      password: 't0k',
    });
  });

  it('accepts password= and cleans the host', () => {
    expect(parseEnrollLink('tak://x/enroll?host=https://tak.example.org:8446/&username=u&password=p')).toEqual({
      host: 'tak.example.org',
      username: 'u',
      password: 'p',
    });
  });

  it('rejects other text', () => {
    expect(parseEnrollLink('tak.example.org')).toBeNull();
    expect(parseEnrollLink('tak://x/enroll?host=h&username=u')).toBeNull();
  });
});

describe('enrollment parsing', () => {
  it('reads naming fields from /tls/config', () => {
    const body =
      '<ns2:certificateConfig xmlns:ns2="com.bbn.marti.config"><nameEntries>' +
      '<nameEntry name="O" value="Org"/><nameEntry name="OU" value="Unit"/></nameEntries></ns2:certificateConfig>';
    expect(parseTlsConfig(body)).toEqual([
      { name: 'O', value: 'Org' },
      { name: 'OU', value: 'Unit' },
    ]);
    expect(parseTlsConfig('<certificateConfig/>')).toEqual([]);
  });

  it('builds a CSR with CN=username and the server fields, signed by a new key', () => {
    const { keyPem, csrPem } = buildCsr('crowdcad-bridge', [
      { name: 'O', value: 'Org' },
      { name: 'CN', value: 'ignored' },
      { name: 'XX', value: 'ignored' },
    ]);
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    expect(csr.verify()).toBe(true);
    expect(csr.subject.getField('CN').value).toBe('crowdcad-bridge');
    expect(csr.subject.getField('O').value).toBe('Org');
    expect(csr.subject.attributes).toHaveLength(2);
    const pub = crypto.createPublicKey(forge.pki.publicKeyToPem(csr.publicKey!));
    expect(pub.equals(crypto.createPublicKey(crypto.createPrivateKey(keyPem)))).toBe(true);
  });

  it('reads JSON (v2) and XML sign responses, keeping CA order', () => {
    const b64 = 'QUJD'.repeat(40);
    const json = parseSignResponse(JSON.stringify({ signedCert: b64, ca1: 'Y2Ex', ca0: 'Y2Ew' }));
    expect(json.certPem).toMatch(/^-----BEGIN CERTIFICATE-----\n(.{64}\n)+.*\n-----END CERTIFICATE-----\n$/);
    expect(json.caPems.map((p) => p.split('\n')[1])).toEqual(['Y2Ew', 'Y2Ex']);
    const xml = parseSignResponse(`<enrollment><signedCert>${b64}</signedCert><ca>Y2Ew</ca></enrollment>`);
    expect(xml.caPems).toHaveLength(1);
    expect(() => parseSignResponse('{}')).toThrow(/no signedCert/);
  });
});

describe('saved enrollment', () => {
  const id = (over: Partial<EnrolledIdentity> = {}): EnrolledIdentity => ({
    keyPem: 'k',
    certPem: 'c',
    caPems: [],
    notAfter: 10_000,
    host: 'h',
    username: 'u',
    enrolledAt: 0,
    ...over,
  });

  it('is reused only for the same server and user, and not near expiry', () => {
    expect(enrollmentUsable(id(), 'h', 'u', 0, 5_000)).toBe(true);
    expect(enrollmentUsable(id(), 'h', 'u', 6_000, 5_000)).toBe(false);
    expect(enrollmentUsable(id(), 'other', 'u', 0, 5_000)).toBe(false);
    expect(enrollmentUsable(id(), 'h', 'other', 0, 5_000)).toBe(false);
    expect(enrollmentUsable(null, 'h', 'u', 0, 5_000)).toBe(false);
  });

  it('round-trips through the data directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-enroll-save-'));
    try {
      expect(loadEnrollment(dir)).toBeNull();
      saveEnrollment(path.join(dir, 'nested'), id());
      expect(loadEnrollment(path.join(dir, 'nested'))).toEqual(id());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const withOpenssl = hasOpenssl() ? describe : describe.skip;

withOpenssl('enroll against a fake TAK Server', () => {
  let dir: string;
  let certs: DevCerts;
  let enrollServer: FakeEnrollServer | null = null;
  let takServer: SimTakServer | null = null;
  let source: CotStreamSource | null = null;
  const read = (p: string) => fs.readFileSync(p, 'utf8');

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-enroll-'));
    certs = generateDevCerts(dir);
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  afterEach(async () => {
    await source?.stop();
    await takServer?.close();
    await enrollServer?.close();
    source = takServer = enrollServer = null;
  });

  async function startEnroll(extra: { maxUses?: number; xml?: boolean } = {}) {
    enrollServer = new FakeEnrollServer({
      tls: { key: read(certs.serverKey), cert: read(certs.serverCert) },
      caKeyPem: read(certs.caKey),
      caCertPem: read(certs.caPem),
      username: 'crowdcad-bridge',
      password: 'secret',
      ...extra,
    });
    return enrollServer.listen();
  }
  const opts = (port: number, password = 'secret') => ({
    host: 'localhost',
    port,
    username: 'crowdcad-bridge',
    password,
    ca: [read(certs.caPem)],
    clientUid: 'crowdcad-bridge-crowdcad-bridge',
  });

  it('gets a certificate for its own key, then streams positions with it', async () => {
    const port = await startEnroll();
    const enrolled = await enroll(opts(port));
    expect(enrolled.caPems).toHaveLength(1);
    expect(enrolled.notAfter).toBeGreaterThan(Date.now());
    expect(enrollServer!.signed).toEqual([{ clientUid: 'crowdcad-bridge-crowdcad-bridge', subject: 'O=Test TAK,OU=Testing,CN=crowdcad-bridge' }]);

    takServer = new SimTakServer({
      simulation: new Simulation({ devices: 2, startTime: Date.now(), center: { lat: 45, lon: -100 }, reportIntervalMs: 1_000 }),
      tls: { key: read(certs.serverKey), cert: read(certs.serverCert), ca: read(certs.caPem) },
      speed: 20,
      tickMs: 50,
    });
    const takPort = await takServer.listen();
    const identity = identityFromEnrollment(enrolled, { host: 'localhost', streamPort: takPort, apiPort: 8443 });
    const positions: DevicePosition[] = [];
    source = new CotStreamSource({ host: 'localhost', port: takPort, identity, log, minBackoffMs: 50 });
    void source.start((e) => positions.push(e.position));
    const deadline = Date.now() + 10_000;
    while (positions.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(positions.length).toBeGreaterThan(0);
  });

  it('understands the older XML response', async () => {
    const port = await startEnroll({ xml: true });
    expect((await enroll(opts(port))).caPems).toHaveLength(1);
  });

  it('explains a wrong password or a used-up token without revealing it', async () => {
    const port = await startEnroll({ maxUses: 1 });
    const wrong = await enroll(opts(port, 'nope-123')).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(EnrollmentError);
    expect((wrong as EnrollmentError).status).toBe(401);
    expect((wrong as Error).message).toMatch(/single-use/);
    expect((wrong as Error).message).not.toContain('nope-123');

    await enroll(opts(port));
    const again = await enroll(opts(port)).catch((e: unknown) => e);
    expect((again as EnrollmentError).status).toBe(401);
  });

  it('explains an unreachable server', async () => {
    const port = await startEnroll();
    await enrollServer!.close();
    enrollServer = null;
    await expect(enroll(opts(port))).rejects.toThrow(/Cannot reach TAK Server enrollment .*8446/);
  });

  it("refuses an enrollment server it can't verify", async () => {
    const port = await startEnroll();
    await expect(enroll({ ...opts(port), ca: undefined })).rejects.toThrow(/Cannot reach.*set TAK_CA/);
  });
});
