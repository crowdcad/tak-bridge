// SPDX-License-Identifier: AGPL-3.0-only

import https from 'node:https';
import type { AddressInfo } from 'node:net';
import forge from 'node-forge';

/**
 * A stand-in for TAK Server's certificate enrollment API on 8446, for tests
 * and local simulation. Checks HTTP basic auth, answers /Marti/api/tls/config,
 * and signs CSRs posted to /Marti/api/tls/signClient/v2 with the given CA.
 */
export interface FakeEnrollServerOptions {
  tls: { key: string; cert: string };
  caKeyPem: string;
  caCertPem: string;
  username: string;
  password: string;
  /** If set, the password works only this many times (like a one-time token). */
  maxUses?: number;
  /** Validity of issued certificates. */
  validityMs?: number;
  /** Respond to signClient with the older XML format instead of JSON. */
  xml?: boolean;
}

export interface SignedRequest {
  clientUid: string | null;
  subject: string;
}

export class FakeEnrollServer {
  private server: https.Server | null = null;
  private uses = 0;
  readonly signed: SignedRequest[] = [];

  constructor(private readonly o: FakeEnrollServerOptions) {}

  listen(): Promise<number> {
    this.server = https.createServer({ key: this.o.tls.key, cert: this.o.tls.cert }, (req, res) => {
      const url = new URL(req.url ?? '/', 'https://localhost');
      const auth = req.headers.authorization ?? '';
      const [user, pass] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString('utf8').split(':');
      const usedUp = this.o.maxUses !== undefined && this.uses >= this.o.maxUses;
      if (user !== this.o.username || pass !== this.o.password || usedUp) {
        res.writeHead(401).end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/Marti/api/tls/config') {
        res.writeHead(200, { 'Content-Type': 'application/xml' }).end(
          '<?xml version="1.0" encoding="UTF-8"?><ns2:certificateConfig xmlns:ns2="com.bbn.marti.config">' +
            '<nameEntries><nameEntry name="O" value="Test TAK"/><nameEntry name="OU" value="Testing"/></nameEntries>' +
            '</ns2:certificateConfig>',
        );
        return;
      }
      if (req.method === 'POST' && url.pathname === '/Marti/api/tls/signClient/v2') {
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => (body += c));
        req.on('end', () => {
          try {
            const csrPem = `-----BEGIN CERTIFICATE REQUEST-----\n${body.trim()}\n-----END CERTIFICATE REQUEST-----`;
            const certPem = this.sign(csrPem, url.searchParams.get('clientUid'));
            this.uses++;
            const strip = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
            if (this.o.xml) {
              res
                .writeHead(200, { 'Content-Type': 'application/xml' })
                .end(`<enrollment><signedCert>${strip(certPem)}</signedCert><ca>${strip(this.o.caCertPem)}</ca></enrollment>`);
            } else {
              res
                .writeHead(200, { 'Content-Type': 'application/json' })
                .end(JSON.stringify({ signedCert: strip(certPem), ca0: strip(this.o.caCertPem) }));
            }
          } catch {
            res.writeHead(400).end();
          }
        });
        return;
      }
      res.writeHead(404).end();
    });
    return new Promise((resolve) => this.server!.listen(0, '127.0.0.1', () => resolve((this.server!.address() as AddressInfo).port)));
  }

  private sign(csrPem: string, clientUid: string | null): string {
    const csr = forge.pki.certificationRequestFromPem(csrPem);
    if (!csr.verify()) throw new Error('bad CSR signature');
    const caCert = forge.pki.certificateFromPem(this.o.caCertPem);
    const cert = forge.pki.createCertificate();
    cert.publicKey = csr.publicKey!;
    cert.serialNumber = String(Date.now() + this.signed.length);
    cert.validity.notBefore = new Date(Date.now() - 60_000);
    cert.validity.notAfter = new Date(Date.now() + (this.o.validityMs ?? 24 * 3600_000));
    cert.setSubject(csr.subject.attributes);
    cert.setIssuer(caCert.subject.attributes);
    cert.setExtensions([{ name: 'extKeyUsage', clientAuth: true }]);
    cert.sign(forge.pki.privateKeyFromPem(this.o.caKeyPem), forge.md.sha256.create());
    this.signed.push({
      clientUid,
      subject: csr.subject.attributes.map((a) => `${a.shortName}=${String(a.value)}`).join(','),
    });
    return forge.pki.certificateToPem(cert);
  }

  close(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
