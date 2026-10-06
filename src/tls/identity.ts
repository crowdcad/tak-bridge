// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import tls from 'node:tls';
import type { TakConfig } from '../config.js';

/**
 * The bridge's TLS identity: its client certificate and key (from the .p12
 * issued by TAK Portal) plus the TAK Server CA. It is loaded once at startup
 * and shared by every connection: the CoT stream on 8089 in v1, and later the
 * TAK-CAD poller on the API port.
 *
 * Node's tls module reads a .p12 directly (pfx + passphrase), so no
 * certificate library is needed.
 */
export interface TlsIdentity {
  /** Raw client .p12 bytes. */
  pfx: Buffer;
  passphrase: string;
  /**
   * Trusted CA certificates (PEM). Empty when TAK_CA is not set; the bridge
   * then trusts the CA certificates bundled in the client .p12, which TAK
   * Server and TAK Portal bundles normally include.
   */
  ca: string[];
  /** TLS server name to verify, when it differs from the host. */
  serverName?: string;
}

export class TlsIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsIdentityError';
  }
}

type ReadFile = (path: string) => Buffer;

/**
 * Loads and checks the identity. Errors explain what to do and never include
 * the password.
 */
export function loadTlsIdentity(tak: TakConfig, readFile: ReadFile = (p) => fs.readFileSync(p)): TlsIdentity {
  let pfx: Buffer;
  try {
    pfx = readFile(tak.clientP12Path);
  } catch {
    throw new TlsIdentityError(
      `Cannot read the client certificate bundle at ${tak.clientP12Path} (TAK_CLIENT_P12). ` +
        'Check that the file exists and is mounted into the container.',
    );
  }

  const ca: string[] = [];
  if (tak.caPath) {
    if (/\.(p12|pfx)$/i.test(tak.caPath)) {
      throw new TlsIdentityError(
        `TAK_CA points to a .p12 file. Convert the truststore to PEM and point TAK_CA at the result:\n` +
          `  openssl pkcs12 -in ${tak.caPath} -nokeys -out ca.pem\n` +
          `(add -legacy if OpenSSL reports an unsupported algorithm). ` +
          'Or leave TAK_CA unset if the client .p12 already includes the CA.',
      );
    }
    let pem: string;
    try {
      pem = readFile(tak.caPath).toString('utf8');
    } catch {
      throw new TlsIdentityError(`Cannot read the TAK Server CA at ${tak.caPath} (TAK_CA).`);
    }
    const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
    if (!certs) throw new TlsIdentityError(`TAK_CA (${tak.caPath}) contains no PEM certificate.`);
    ca.push(...certs);
  }

  const identity: TlsIdentity = { pfx, passphrase: tak.clientP12Password, ca, serverName: tak.serverName };
  try {
    tls.createSecureContext({ pfx: identity.pfx, passphrase: identity.passphrase, ...(ca.length ? { ca } : {}) });
  } catch (err) {
    throw new TlsIdentityError(describeP12Error(err, tak.clientP12Path));
  }
  return identity;
}

function describeP12Error(err: unknown, path: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/mac verify|invalid password|bad decrypt/i.test(msg)) {
    return `Cannot open ${path}: the password (TAK_CLIENT_P12_PASSWORD) is wrong.`;
  }
  if (/unsupported/i.test(msg)) {
    return (
      `Cannot open ${path}: it uses legacy encryption that this OpenSSL version disables. ` +
      'Either re-export it with modern encryption:\n' +
      '  openssl pkcs12 -legacy -in client.p12 -nodes -out tmp.pem\n' +
      '  openssl pkcs12 -export -in tmp.pem -out client-modern.p12 && rm tmp.pem\n' +
      'or set NODE_OPTIONS=--openssl-legacy-provider for the container.'
    );
  }
  return `Cannot use ${path} as a client certificate bundle: ${msg}`;
}

/** Options for tls.connect from an identity. */
export function tlsConnectOptions(identity: TlsIdentity): tls.ConnectionOptions {
  return {
    pfx: identity.pfx,
    passphrase: identity.passphrase,
    ...(identity.ca.length ? { ca: identity.ca } : {}),
    ...(identity.serverName ? { servername: identity.serverName } : {}),
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
  };
}
