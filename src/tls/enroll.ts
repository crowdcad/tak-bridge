// SPDX-License-Identifier: AGPL-3.0-only

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import tls from 'node:tls';
import forge from 'node-forge';
import { XMLParser } from 'fast-xml-parser';

/**
 * TAK Server certificate enrollment: the same flow ATAK and iTAK use when you
 * scan an "Enroll" QR code in TAK Portal.
 *
 * 1. GET  https://<host>:8446/Marti/api/tls/config with the TAK username and
 *    password (or one-time token) returns the certificate naming fields.
 * 2. The bridge generates its own key and a certificate request (CSR). The
 *    private key never leaves this machine.
 * 3. POST https://<host>:8446/Marti/api/tls/signClient/v2 returns the signed
 *    client certificate and the TAK Server's CA chain.
 *
 * The result is saved to the data directory and reused until it is close to
 * expiring.
 */

export interface EnrollLink {
  host: string;
  username: string;
  password: string;
}

/**
 * Parses TAK Portal's "Enroll QR" contents, e.g.
 * tak://com.atakmap.app/enroll?host=tak.example.org&username=bridge&token=XXXX
 * (some servers use password= instead of token=).
 */
export function parseEnrollLink(text: string): EnrollLink | null {
  const trimmed = text.trim();
  const query = trimmed.includes('?') ? trimmed.slice(trimmed.indexOf('?') + 1) : '';
  if (!query) return null;
  const params = new URLSearchParams(query);
  const host = params.get('host')?.trim();
  const username = params.get('username')?.trim();
  const password = (params.get('token') ?? params.get('password'))?.trim();
  if (!host || !username || !password) return null;
  return { host: host.replace(/^https?:\/\//, '').replace(/[:/].*$/, ''), username, password };
}

export interface NameEntry {
  name: string;
  value: string;
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', removeNSPrefix: true });

/** Certificate naming fields from /Marti/api/tls/config (O, OU, ...). */
export function parseTlsConfig(body: string): NameEntry[] {
  const doc = xml.parse(body) as Record<string, unknown>;
  const found: NameEntry[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const rec = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(rec)) {
      if (key === 'nameEntry') {
        for (const e of Array.isArray(value) ? value : [value]) {
          const entry = e as Record<string, unknown>;
          if (typeof entry.name === 'string' && typeof entry.value === 'string') found.push({ name: entry.name, value: entry.value });
        }
      } else visit(value);
    }
  };
  visit(doc);
  return found;
}

const SHORT_NAMES = new Set(['C', 'ST', 'L', 'O', 'OU', 'CN', 'E']);

/** A new RSA key and a certificate request with CN=username plus the server's naming fields. */
export function buildCsr(username: string, nameEntries: NameEntry[]): { keyPem: string; csrPem: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const attrs: forge.pki.CertificateField[] = nameEntries
    .filter((e) => SHORT_NAMES.has(e.name) && e.name !== 'CN')
    .map((e) => ({ shortName: e.name, value: e.value }));
  attrs.push({ shortName: 'CN', value: username });
  csr.setSubject(attrs);
  csr.sign(forge.pki.privateKeyFromPem(keyPem), forge.md.sha256.create());
  return { keyPem, csrPem: forge.pki.certificationRequestToPem(csr) };
}

const toPem = (b64: string) => {
  const body = b64.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
};

/** The signed certificate and CA chain from signClient (JSON from v2, XML from older servers). */
export function parseSignResponse(body: string): { certPem: string; caPems: string[] } {
  const text = body.trim();
  if (text.startsWith('{')) {
    const json = JSON.parse(text) as Record<string, string>;
    if (!json.signedCert) throw new Error('enrollment response has no signedCert');
    const caPems = Object.keys(json)
      .filter((k) => /^ca\d+$/.test(k))
      .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)))
      .map((k) => toPem(json[k]!));
    return { certPem: toPem(json.signedCert), caPems };
  }
  const doc = xml.parse(text) as { enrollment?: { signedCert?: string; ca?: string | string[] } };
  const signed = doc.enrollment?.signedCert;
  if (!signed) throw new Error('enrollment response has no signedCert');
  const cas = doc.enrollment?.ca;
  return { certPem: toPem(signed), caPems: (Array.isArray(cas) ? cas : cas ? [cas] : []).map(toPem) };
}

export interface EnrollOptions {
  host: string;
  port: number;
  username: string;
  password: string;
  /** Extra CAs (PEM) to trust for the enrollment endpoint, in addition to the public ones. */
  ca?: string[];
  clientUid: string;
}

export interface EnrolledIdentity {
  keyPem: string;
  certPem: string;
  caPems: string[];
  /** Certificate validity end, epoch ms. */
  notAfter: number;
  host: string;
  username: string;
  enrolledAt: number;
}

export class EnrollmentError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'EnrollmentError';
  }
}

function request(
  o: EnrollOptions,
  method: 'GET' | 'POST',
  urlPath: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${o.username}:${o.password}`).toString('base64');
    const req = https.request(
      {
        host: o.host,
        port: o.port,
        path: urlPath,
        method,
        timeout: 20_000,
        // Extra CAs are added to, not instead of, the public roots: 8446 often has a public certificate.
        ...(o.ca?.length ? { ca: [...tls.rootCertificates, ...o.ca] } : {}),
        headers: { Authorization: `Basic ${auth}`, ...headers, ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function explain(status: number, step: string): EnrollmentError {
  if (status === 401 || status === 403) {
    return new EnrollmentError(
      `TAK Server refused the username or password (${step}, HTTP ${status}). Check TAK_USERNAME and TAK_PASSWORD; ` +
        "a token from TAK Portal's Enroll QR may be single-use or expired, so generate a new one.",
      status,
    );
  }
  return new EnrollmentError(`TAK Server enrollment failed (${step}, HTTP ${status}).`, status);
}

/** Enrolls with TAK Server and returns the new identity. Never logs the password or key. */
export async function enroll(o: EnrollOptions): Promise<EnrolledIdentity> {
  let config;
  try {
    config = await request(o, 'GET', '/Marti/api/tls/config');
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    const untrusted = /CERT|SELF_SIGNED|UNABLE_TO/.test(e.code ?? '');
    throw new EnrollmentError(
      `Cannot reach TAK Server enrollment at ${o.host}:${o.port}: ${e.message}. ` +
        (untrusted
          ? "Port 8446 uses a certificate this computer doesn't trust (often TAK Server's own CA): set TAK_CA to the TAK Server CA as a PEM file."
          : 'Check TAK_ENROLL_HOST/TAK_HOST and that port 8446 is reachable from here.'),
    );
  }
  if (config.status !== 200) throw explain(config.status, 'reading enrollment settings');

  const { keyPem, csrPem } = buildCsr(o.username, parseTlsConfig(config.body));
  // TAK Server takes the CSR body without the PEM header lines.
  const csrBody = csrPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const query = `clientUid=${encodeURIComponent(o.clientUid)}&version=${encodeURIComponent('crowdcad-tak-bridge')}`;
  const signed = await request(o, 'POST', `/Marti/api/tls/signClient/v2?${query}`, csrBody, {
    'Content-Type': 'text/plain',
    Accept: 'application/json',
  });
  if (signed.status !== 200) throw explain(signed.status, 'signing the certificate request');

  const { certPem, caPems } = parseSignResponse(signed.body);
  const cert = new crypto.X509Certificate(certPem);
  if (!cert.checkPrivateKey(crypto.createPrivateKey(keyPem))) {
    throw new EnrollmentError('TAK Server returned a certificate that does not match the generated key.');
  }
  return {
    keyPem,
    certPem,
    caPems,
    notAfter: Date.parse(cert.validTo),
    host: o.host,
    username: o.username,
    enrolledAt: Date.now(),
  };
}

const FILE = 'enrollment.json';

export function loadEnrollment(dataDir: string): EnrolledIdentity | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, FILE), 'utf8')) as EnrolledIdentity;
  } catch {
    return null;
  }
}

export function saveEnrollment(dataDir: string, identity: EnrolledIdentity): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, FILE);
  fs.writeFileSync(file, JSON.stringify(identity, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Not supported on every filesystem (e.g. Windows); the file is in the bridge's own data directory.
  }
}

/** True if a saved identity can be used: same server and user, and not within renewWithinMs of expiring. */
export function enrollmentUsable(id: EnrolledIdentity | null, host: string, username: string, now: number, renewWithinMs: number): boolean {
  return !!id && id.host === host && id.username === username && id.notAfter - now > renewWithinMs;
}
