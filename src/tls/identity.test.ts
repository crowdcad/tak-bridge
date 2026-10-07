// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TakConfig } from '../config.js';
import { generateDevCerts, hasOpenssl, type DevCerts } from '../testing/certs.js';
import { TlsIdentityError, loadTlsIdentity } from './identity.js';

const withOpenssl = hasOpenssl() ? describe : describe.skip;

withOpenssl('loadTlsIdentity', () => {
  let dir: string;
  let certs: DevCerts;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-identity-'));
    certs = generateDevCerts(dir);
  }, 60_000);
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const tak = (over: Partial<TakConfig>): TakConfig => ({
    host: 'localhost',
    streamPort: 8089,
    apiPort: 8443,
    clientP12Path: certs.clientP12,
    clientP12Password: certs.password,
    ...over,
  });

  const errorOf = (cfg: TakConfig): TlsIdentityError => {
    try {
      loadTlsIdentity(cfg);
    } catch (err) {
      if (err instanceof TlsIdentityError) return err;
      throw err;
    }
    throw new Error('expected a TlsIdentityError');
  };

  it('loads a .p12 and an optional PEM CA', () => {
    // CA certificates bundled in the .p12 are extracted and pinned.
    expect(loadTlsIdentity(tak({})).ca).toHaveLength(1);
    expect(loadTlsIdentity(tak({ clientP12Path: certs.clientP12NoCa })).ca).toEqual([]);
    const withCa = loadTlsIdentity(tak({ caPath: certs.caPem }));
    expect(withCa.ca).toHaveLength(1);
    expect(withCa.kind === 'pfx' && withCa.pfx.length).toBeGreaterThan(0);
  });

  it('explains a wrong password without revealing it', () => {
    const err = errorOf(tak({ clientP12Password: 'not-the-password' }));
    expect(err.message).toMatch(/password .* is wrong/);
    expect(err.message).not.toContain('not-the-password');
  });

  it('explains a missing file', () => {
    expect(errorOf(tak({ clientP12Path: path.join(dir, 'missing.p12') })).message).toMatch(/Cannot read/);
  });

  it('asks for a PEM when TAK_CA is a .p12', () => {
    expect(errorOf(tak({ caPath: path.join(dir, 'truststore.p12') })).message).toMatch(/Convert the truststore to PEM/);
  });

  it('rejects a CA file with no certificate', () => {
    const bad = path.join(dir, 'empty.pem');
    fs.writeFileSync(bad, 'nothing here');
    expect(errorOf(tak({ caPath: bad })).message).toMatch(/contains no PEM certificate/);
  });

  it('either loads a legacy-encrypted .p12 or explains how to convert it', () => {
    if (!certs.clientP12Legacy) return;
    try {
      loadTlsIdentity(tak({ clientP12Path: certs.clientP12Legacy }));
    } catch (err) {
      expect(err).toBeInstanceOf(TlsIdentityError);
      expect((err as Error).message).toMatch(/legacy encryption|openssl/);
      expect((err as Error).message).not.toContain(certs.password);
    }
  });
});
