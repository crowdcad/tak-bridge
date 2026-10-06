// SPDX-License-Identifier: AGPL-3.0-only

import { ConfigError, describeConfig, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { CotStreamSource } from './sources/cot-stream.js';
import { TlsIdentityError, loadTlsIdentity } from './tls/identity.js';

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee .env.example for every setting.\n`);
      return 1;
    }
    throw err;
  }

  const log = createLogger(config.logLevel);
  log.info('tak-bridge starting', describeConfig(config));

  let identity;
  try {
    identity = loadTlsIdentity(config.tak);
  } catch (err) {
    if (err instanceof TlsIdentityError) {
      log.error(err.message);
      return 1;
    }
    throw err;
  }

  if (config.backend.kind !== 'none') {
    // Backend writes arrive in P2. Until then every mode only logs positions.
    log.warn('backend writes are not implemented yet; logging positions only');
  }

  const source = new CotStreamSource({ host: config.tak.host, port: config.tak.streamPort, identity, log });
  await source.start((event) => {
    if (event.kind !== 'position') return;
    const p = event.position;
    log.info('position', {
      uid: p.deviceUid,
      callsign: p.callsign,
      lat: p.lat,
      lon: p.lon,
      deviceTime: new Date(p.deviceTime).toISOString(),
    });
  });

  await new Promise<void>((resolve) => {
    const shutdown = (signal: string) => {
      log.info('shutting down', { signal });
      void source.stop().then(resolve);
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
