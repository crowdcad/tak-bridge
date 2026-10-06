// SPDX-License-Identifier: AGPL-3.0-only

import { ConfigError, describeConfig, loadConfig } from './config.js';
import { createLogger } from './log.js';

function main(): number {
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
  log.info('tak-bridge configuration loaded', describeConfig(config));
  // The CoT stream (P1) and backend writes (P2) are not implemented yet.
  log.warn('tak-bridge is in development: no TAK connection is made in this build');
  return 0;
}

process.exitCode = main();
