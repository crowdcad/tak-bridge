// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Throwaway certificates for tests and for running the simulator locally.
 * Generated with the openssl CLI into a directory you choose, never into the
 * repository. Not for real deployments.
 */
export interface DevCerts {
  dir: string;
  caPem: string;
  caKey: string;
  serverKey: string;
  serverCert: string;
  /** Client .p12 that also bundles the CA certificate. */
  clientP12: string;
  /** Client .p12 with only the client certificate and key. */
  clientP12NoCa: string;
  /** Client .p12 using legacy (RC2/3DES) encryption, as some older TAK tooling produces. Absent if openssl can't make one. */
  clientP12Legacy?: string;
  password: string;
}

export function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function generateDevCerts(dir: string, password = 'atakatak'): DevCerts {
  fs.mkdirSync(dir, { recursive: true });
  const f = (name: string) => path.join(dir, name);
  const run = (args: string[]) => execFileSync('openssl', args, { stdio: 'pipe', cwd: dir });
  const subj = (cn: string) => `/CN=${cn}`;

  fs.writeFileSync(f('server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  fs.writeFileSync(f('client.ext'), 'extendedKeyUsage=clientAuth\n');

  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', subj('Dev TAK CA')]);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', subj('localhost')]);
  run(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.pem', '-days', '2', '-extfile', 'server.ext']);
  run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'client.key', '-out', 'client.csr', '-subj', subj('crowdcad-bridge')]);
  run(['x509', '-req', '-in', 'client.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'client.pem', '-days', '2', '-extfile', 'client.ext']);
  const pass = `pass:${password}`;
  run(['pkcs12', '-export', '-in', 'client.pem', '-inkey', 'client.key', '-certfile', 'ca.pem', '-out', 'client.p12', '-passout', pass]);
  run(['pkcs12', '-export', '-in', 'client.pem', '-inkey', 'client.key', '-out', 'client-noca.p12', '-passout', pass]);

  let clientP12Legacy: string | undefined;
  try {
    run(['pkcs12', '-export', '-legacy', '-in', 'client.pem', '-inkey', 'client.key', '-out', 'client-legacy.p12', '-passout', pass]);
    clientP12Legacy = f('client-legacy.p12');
  } catch {
    clientP12Legacy = undefined;
  }

  return {
    dir,
    caPem: f('ca.pem'),
    caKey: f('ca.key'),
    serverKey: f('server.key'),
    serverCert: f('server.pem'),
    clientP12: f('client.p12'),
    clientP12NoCa: f('client-noca.p12'),
    clientP12Legacy,
    password,
  };
}

/** `npm run dev-certs [dir]`: writes dev certificates for the simulator, default ./certs/dev. */
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('testing', 'certs.js'))) {
  const dir = path.resolve(process.argv[2] ?? 'certs/dev');
  const certs = generateDevCerts(dir);
  process.stdout.write(
    `Dev certificates written to ${certs.dir} (not for real use).\n` +
      `Client bundle: ${certs.clientP12} (password: ${certs.password})\n`,
  );
}
