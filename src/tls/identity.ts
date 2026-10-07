// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import tls from 'node:tls';
import forge from 'node-forge';
import type { TakConfig } from '../config.js';
import type { EnrolledIdentity } from './enroll.js';

/**
 * The bridge's TLS identity: its client certificate and key, plus the TAK
 * Server CA. It comes either from enrollment (TAK_USERNAME/TAK_PASSWORD,
 * see enroll.ts) or from a .p12 bundle (TAK_CLIENT_P12), and is shared by
 * every connection: the CoT stream on 8089 now, and later the TAK-CAD poller.
 *
 * Server verification: when a TAK CA is known (from enrollment or TAK_CA, or
 * bundled in the .p12), the server certificate must chain to it. TAK Server
 * certificates are usually issued to an internal name such as "takserver"
 * rather than the public hostname, so the name is then checked only if
 * TAK_SERVER_NAME is set. Trust stays limited to the TAK CA either way.
 */
export type TlsIdentity =
  | { kind: 'pfx'; pfx: Buffer; passphrase: string; ca: string[]; serverName?: string; source: string }
  | { kind: 'pem'; key: string; cert: string; ca: string[]; serverName?: string; source: string };

export class TlsIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TlsIdentityError';
  }
}

type ReadFile = (path: string) => Buffer;

export function readCa(tak: TakConfig, readFile: ReadFile = (p) => fs.readFileSync(p)): string[] {
  if (!tak.caPath) return [];
  if (/\.(p12|pfx)$/i.test(tak.caPath)) {
    throw new TlsIdentityError(
      `TAK_CA points to a .p12 file. Convert the truststore to PEM and point TAK_CA at the result:\n` +
        `  openssl pkcs12 -in ${tak.caPath} -nokeys -out ca.pem\n` +
        `(add -legacy if OpenSSL reports an unsupported algorithm).`,
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
  return certs;
}

/** Identity from an enrollment result. */
export function identityFromEnrollment(enrolled: EnrolledIdentity, tak: TakConfig, readFile: ReadFile = (p) => fs.readFileSync(p)): TlsIdentity {
  return {
    kind: 'pem',
    key: enrolled.keyPem,
    cert: enrolled.certPem,
    ca: [...enrolled.caPems, ...readCa(tak, readFile)],
    serverName: tak.serverName,
    source: `enrolled as ${enrolled.username}`,
  };
}

/** Identity from TAK_CLIENT_P12. Errors explain what to do and never include the password. */
export function loadTlsIdentity(tak: TakConfig, readFile: ReadFile = (p) => fs.readFileSync(p)): TlsIdentity {
  if (!tak.clientP12Path) throw new TlsIdentityError('No client certificate configured (TAK_CLIENT_P12).');
  let pfx: Buffer;
  try {
    pfx = readFile(tak.clientP12Path);
  } catch {
    throw new TlsIdentityError(
      `Cannot read the client certificate bundle at ${tak.clientP12Path} (TAK_CLIENT_P12). ` +
        'Check that the file exists and is mounted into the container, or use TAK_USERNAME/TAK_PASSWORD to enroll instead.',
    );
  }
  let ca = readCa(tak, readFile);
  // Without TAK_CA, pin the CA certificates bundled in the .p12 so that only
  // they (not every public root CA) are trusted for the TAK Server.
  if (ca.length === 0) ca = pfxCaCerts(pfx, tak.clientP12Password ?? '');
  const identity: TlsIdentity = {
    kind: 'pfx',
    pfx,
    passphrase: tak.clientP12Password ?? '',
    ca,
    serverName: tak.serverName,
    source: tak.clientP12Path,
  };
  try {
    tls.createSecureContext({ pfx, passphrase: identity.passphrase, ...(ca.length ? { ca } : {}) });
  } catch (err) {
    throw new TlsIdentityError(describeP12Error(err, tak.clientP12Path));
  }
  return identity;
}

/** CA certificates bundled in a .p12 (every certificate except the one matching the private key). */
export function pfxCaCerts(pfx: Buffer, passphrase: string): string[] {
  try {
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfx.toString('binary')), passphrase);
    const keyOid = forge.pki.oids.pkcs8ShroudedKeyBag!;
    const certOid = forge.pki.oids.certBag!;
    const keyBags: forge.pkcs12.Bag[] = p12.getBags({ bagType: keyOid })[keyOid] ?? [];
    const key = keyBags[0]?.key as forge.pki.rsa.PrivateKey | undefined;
    const certBags: forge.pkcs12.Bag[] = p12.getBags({ bagType: certOid })[certOid] ?? [];
    const certs = certBags.map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
    return certs
      .filter((c: forge.pki.Certificate) => !key || (c.publicKey as forge.pki.rsa.PublicKey).n.compareTo(key.n) !== 0)
      .map((c: forge.pki.Certificate) => forge.pki.certificateToPem(c));
  } catch {
    return []; // unreadable here (Node validates the bundle separately); fall back to full verification
  }
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
  const base: tls.ConnectionOptions =
    identity.kind === 'pfx'
      ? { pfx: identity.pfx, passphrase: identity.passphrase }
      : { key: identity.key, cert: identity.cert };
  // A TAK CA is pinned (explicit, enrolled, or extracted from the .p12): verify
  // the chain against it, and the name only when TAK_SERVER_NAME says what to
  // expect. Without a pinned CA, Node's normal hostname checks apply.
  const pinnedCa = identity.ca.length > 0;
  return {
    ...base,
    ...(identity.ca.length ? { ca: identity.ca } : {}),
    ...(identity.serverName ? { servername: identity.serverName } : {}),
    ...(pinnedCa && !identity.serverName ? { checkServerIdentity: () => undefined } : {}),
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
  };
}
