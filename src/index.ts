// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import { FirebaseAdapter } from './backend/firebase.js';
import { PocketBaseAdapter } from './backend/pocketbase.js';
import type { BackendAdapter } from './backend/types.js';
import { Bridge } from './bridge.js';
import { ConfigError, describeConfig, loadConfig, type BridgeConfig } from './config.js';
import { createLogger, type Logger } from './log.js';
import { CotStreamSource } from './sources/cot-stream.js';
import { EnrollmentError } from './tls/enroll.js';
import { TlsIdentityError } from './tls/identity.js';
import { provisionIdentity, scheduleRenewal } from './tls/provision.js';

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function createAdapter(config: BridgeConfig): BackendAdapter | null {
  const b = config.backend;
  if (b.kind === 'firebase') return new FirebaseAdapter({ apiKey: b.apiKey, projectId: b.projectId, authDomain: b.authDomain });
  if (b.kind === 'pocketbase') return new PocketBaseAdapter({ url: b.url });
  return null;
}

async function main(): Promise<number> {
  let config: BridgeConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee .env.example for every setting.\n`);
      return 1;
    }
    throw err;
  }

  const log: Logger = createLogger(config.logLevel);
  const version = readVersion();
  log.info('tak-bridge starting', { version, ...describeConfig(config) });

  let provisioned;
  try {
    provisioned = await provisionIdentity(config.tak, config.dataDir, log);
  } catch (err) {
    if (err instanceof TlsIdentityError || err instanceof EnrollmentError) {
      log.error(err.message);
      return 1;
    }
    throw err;
  }

  const source = new CotStreamSource({
    host: config.tak.host,
    port: config.tak.streamPort,
    identity: provisioned.identity,
    log,
  });
  const stopRenewal = provisioned.enrolled
    ? scheduleRenewal(config.tak, config.dataDir, log, provisioned.enrolled, (identity) => source.updateIdentity(identity))
    : () => {};
  const adapter = createAdapter(config);
  let bridge: Bridge | null = null;

  if (adapter) {
    bridge = new Bridge({
      adapter,
      log,
      version,
      takConnected: () => source.isConnected(),
      takError: () => source.lastError,
    });
    try {
      await bridge.start(config.bridgeEmail, config.bridgePassword);
    } catch (err) {
      log.error('could not sign in to CrowdCAD as the bridge account; check BRIDGE_EMAIL and BRIDGE_PASSWORD', {
        message: (err as Error).message,
      });
      await adapter.close();
      return 1;
    }
    log.info('linked events', { events: bridge.linkedEvents.map((e) => e.eventId) });
  } else {
    log.info('log-only mode (CROWDCAD_BACKEND=none): positions are logged, nothing is written');
  }

  await source.start((event) => {
    if (event.kind !== 'position') return;
    const p = event.position;
    if (bridge) {
      bridge.handlePosition(p);
      log.debug('position', { uid: p.deviceUid, callsign: p.callsign });
    } else {
      log.info('position', {
        uid: p.deviceUid,
        callsign: p.callsign,
        lat: p.lat,
        lon: p.lon,
        deviceTime: new Date(p.deviceTime).toISOString(),
      });
    }
  });

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      log.info('shutting down', { signal });
      void (async () => {
        stopRenewal();
        await source.stop();
        await bridge?.stop();
        await adapter?.close();
        resolve();
      })();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  },
);
