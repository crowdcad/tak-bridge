// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import PocketBase from 'pocketbase';
import { coreDir } from './core.js';

/**
 * A throwaway local PocketBase for tests: the binary named by POCKETBASE_BIN,
 * a temporary data directory, and crowdcad/crowdcad's real
 * scripts/setup-pocketbase.js (schema and rules) applied to it.
 */
export interface LocalPocketBase {
  url: string;
  /** Client authenticated as superuser (bypasses collection rules), for seeding. */
  admin: PocketBase;
  stop(): Promise<void>;
}

const SUPER_EMAIL = 'superuser@tests.local';
const SUPER_PASSWORD = 'superuser-test-password';

export function pocketbaseAvailable(): boolean {
  return Boolean(process.env.POCKETBASE_BIN && process.env.CROWDCAD_CORE_DIR);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

export async function startPocketBase(): Promise<LocalPocketBase> {
  const bin = process.env.POCKETBASE_BIN;
  if (!bin) throw new Error('Set POCKETBASE_BIN to a PocketBase binary to run these tests.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tak-pb-'));
  const dataDir = path.join(dir, 'pb_data');
  execFileSync(bin, ['superuser', 'upsert', SUPER_EMAIL, SUPER_PASSWORD, '--dir', dataDir], { stdio: 'ignore' });

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn(bin, ['serve', `--http=127.0.0.1:${port}`, '--dir', dataDir], { stdio: 'ignore' });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error('PocketBase did not start');
    await new Promise((r) => setTimeout(r, 200));
  }

  execFileSync(process.execPath, [path.join(coreDir(), 'scripts', 'setup-pocketbase.js')], {
    env: { ...process.env, PB_URL: url, PB_ADMIN_EMAIL: SUPER_EMAIL, PB_ADMIN_PASSWORD: SUPER_PASSWORD },
    stdio: 'ignore',
  });

  const admin = new PocketBase(url);
  admin.autoCancellation(false);
  await admin.collection('_superusers').authWithPassword(SUPER_EMAIL, SUPER_PASSWORD);

  return {
    url,
    admin,
    async stop() {
      proc.kill();
      await new Promise((r) => setTimeout(r, 300));
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A client signed in as the given user. */
export async function clientFor(url: string, email: string, password: string): Promise<PocketBase> {
  const pb = new PocketBase(url);
  pb.autoCancellation(false);
  await pb.collection('users').authWithPassword(email, password);
  return pb;
}
