// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../log.js';
import { Simulation } from '../sim/model.js';
import { SimTakServer } from '../sim/server.js';
import { generateDevCerts, hasOpenssl, type DevCerts } from '../testing/certs.js';
import { loadTlsIdentity } from '../tls/identity.js';
import { CotStreamSource, describeTlsError } from './cot-stream.js';
import type { DevicePosition } from './types.js';

const withOpenssl = hasOpenssl() ? describe : describe.skip;
const log = createLogger('error', () => {});
const center = { lat: 45.0012, lon: -100.0021 };

async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

withOpenssl('CotStreamSource against the simulated TAK Server', () => {
  let dir: string;
  let certs: DevCerts;
  let server: SimTakServer | null = null;
  let source: CotStreamSource | null = null;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-stream-'));
    certs = generateDevCerts(dir);
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  afterEach(async () => {
    await source?.stop();
    await server?.close();
    source = null;
    server = null;
  });

  async function startServer(opts: { noise?: boolean; fragment?: boolean; speed?: number } = {}) {
    server = new SimTakServer({
      simulation: new Simulation({ devices: 5, startTime: Date.now(), center, reportIntervalMs: 1_000 }),
      tls: {
        key: fs.readFileSync(certs.serverKey, 'utf8'),
        cert: fs.readFileSync(certs.serverCert, 'utf8'),
        ca: fs.readFileSync(certs.caPem, 'utf8'),
      },
      speed: opts.speed ?? 20,
      tickMs: 50,
      noise: opts.noise,
      fragment: opts.fragment,
    });
    return server.listen();
  }

  function startSource(port: number, p12 = certs.clientP12, caPath?: string, serverName?: string) {
    const identity = loadTlsIdentity({
      host: 'localhost',
      streamPort: port,
      apiPort: 8443,
      clientP12Path: p12,
      clientP12Password: certs.password,
      caPath,
      serverName,
    });
    const positions: DevicePosition[] = [];
    source = new CotStreamSource({ host: 'localhost', port, identity, log, minBackoffMs: 50, maxBackoffMs: 200 });
    void source.start((e) => positions.push(e.position));
    return positions;
  }

  it('receives positions within 5 s, through fragmentation and non-position noise', async () => {
    const port = await startServer({ noise: true, fragment: true });
    const t0 = Date.now();
    const positions = startSource(port);
    await waitFor(() => positions.length > 0, 5_000);
    expect(Date.now() - t0).toBeLessThan(5_000);

    await waitFor(() => positions.length >= 50);
    expect(source!.isConnected()).toBe(true);
    expect(new Set(positions.map((p) => p.deviceUid)).size).toBe(5);
    for (const p of positions) {
      expect(p.cotType.startsWith('a-')).toBe(true);
      expect(p.lat === 0 && p.lon === 0).toBe(false);
      expect(p.callsign).toMatch(/^Team \d$/);
    }
    expect(source!.stats.invalid).toBe(0);
  });

  it('trusts the CA bundled in the client .p12, or an explicit TAK_CA', async () => {
    const port = await startServer();
    const positions = startSource(port, certs.clientP12NoCa, certs.caPem);
    await waitFor(() => positions.length > 0);
  });

  it('refuses a server it cannot verify', async () => {
    const port = await startServer();
    const positions = startSource(port, certs.clientP12NoCa); // no CA anywhere
    await new Promise((r) => setTimeout(r, 1_000));
    expect(positions).toHaveLength(0);
    expect(source!.isConnected()).toBe(false);
    expect(source!.lastError).toMatch(/isn't trusted/);
  });

  it('checks the server name only when TAK_SERVER_NAME is set', async () => {
    const port = await startServer();
    const positions = startSource(port, certs.clientP12, undefined, 'takserver'); // the dev server cert is for localhost
    await new Promise((r) => setTimeout(r, 1_000));
    expect(positions).toHaveLength(0);
    expect(source!.lastError).toMatch(/TAK_SERVER_NAME/);
  });

  it('reconnects after the server drops the connection', async () => {
    const port = await startServer();
    const positions = startSource(port);
    await waitFor(() => positions.length > 0);
    server!.dropClients();
    const before = positions.length;
    await waitFor(() => source!.stats.connects >= 2);
    await waitFor(() => positions.length > before + 5);
  });
});

describe('describeTlsError', () => {
  const e = (code: string, message = '') => Object.assign(new Error(message), { code });
  it('explains common failures in plain words', () => {
    expect(describeTlsError(e('ECONNREFUSED'))).toMatch(/TAK_STREAM_PORT/);
    expect(describeTlsError(e('ENOTFOUND'))).toMatch(/DNS/);
    expect(describeTlsError(e('ERR_TLS_CERT_ALTNAME_INVALID'))).toMatch(/TAK_SERVER_NAME/);
    expect(describeTlsError(e('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toMatch(/isn't trusted/);
    expect(describeTlsError(e('ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE', 'sslv3 alert bad certificate'))).toMatch(/rejected the bridge certificate/);
    expect(describeTlsError(e('EOTHER', 'something else'))).toBe('something else');
  });
});
