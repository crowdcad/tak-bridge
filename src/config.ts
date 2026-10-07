// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bridge configuration, read from the environment (see .env.example).
 *
 * Validation collects every problem before failing, so an operator sees all
 * missing or invalid variables at once. Error messages name variables only and
 * never include their values, since several of them are secrets.
 */

import { parseEnrollLink } from './tls/enroll.js';

export type BackendKind = 'firebase' | 'pocketbase' | 'none';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TakConfig {
  host: string;
  /** TLS CoT streaming port. */
  streamPort: number;
  /** TAK Server API port. Reserved for the TAK-CAD poller; unused in v1. */
  apiPort: number;
  /**
   * Certificate enrollment (preferred): the bridge requests its own client
   * certificate from TAK Server with the TAK Portal user's credentials.
   */
  enroll?: { host: string; port: number; username: string; password: string };
  /** Alternative: a client certificate bundle (.p12) made elsewhere. */
  clientP12Path?: string;
  clientP12Password?: string;
  /**
   * Path to the TAK Server CA as PEM. Optional: when unset, the CA certificates
   * bundled in the client .p12 are trusted.
   */
  caPath?: string;
  /** Optional TLS server name override, when the certificate name differs from host. */
  serverName?: string;
}

export type BackendConfig =
  | { kind: 'firebase'; apiKey: string; projectId: string; authDomain: string }
  | { kind: 'pocketbase'; url: string }
  /** Log positions only and write nothing. For setup checks and diagnostics. */
  | { kind: 'none' };

export interface BridgeConfig {
  tak: TakConfig;
  /** Where the enrolled certificate is kept between runs. */
  dataDir: string;
  backend: BackendConfig;
  bridgeEmail: string;
  bridgePassword: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export function loadConfig(env: Env = process.env): BridgeConfig {
  const problems: string[] = [];

  const str = (name: string, fallback?: string): string => {
    const value = env[name]?.trim();
    if (value) return value;
    if (fallback !== undefined) return fallback;
    problems.push(`${name} is required`);
    return '';
  };
  const optional = (name: string): string | undefined => env[name]?.trim() || undefined;
  const port = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      problems.push(`${name} must be a port number (1-65535)`);
      return fallback;
    }
    return value;
  };

  // TAK Portal's "Enroll QR" link can stand in for host, username and password.
  const enrollUrl = optional('TAK_ENROLL_URL');
  const link = enrollUrl ? parseEnrollLink(enrollUrl) : null;
  if (enrollUrl && !link) problems.push('TAK_ENROLL_URL is not a TAK enrollment link (expected ...?host=...&username=...&token=...)');

  const host = optional('TAK_HOST') ?? link?.host;
  if (!host) problems.push('TAK_HOST is required');
  const username = optional('TAK_USERNAME') ?? link?.username;
  const password = optional('TAK_PASSWORD') ?? link?.password;
  const p12Password = optional('TAK_CLIENT_P12_PASSWORD');
  const p12Path = optional('TAK_CLIENT_P12') ?? (p12Password ? '/certs/client.p12' : undefined);

  const tak: TakConfig = {
    host: host ?? '',
    streamPort: port('TAK_STREAM_PORT', 8089),
    apiPort: port('TAK_API_PORT', 8443),
    caPath: optional('TAK_CA'),
    serverName: optional('TAK_SERVER_NAME'),
  };
  if (username && password) {
    tak.enroll = { host: optional('TAK_ENROLL_HOST') ?? host ?? '', port: port('TAK_ENROLL_PORT', 8446), username, password };
  } else if (username || password) {
    problems.push('TAK_USERNAME and TAK_PASSWORD must both be set to enroll');
  }
  if (p12Path) {
    tak.clientP12Path = p12Path;
    tak.clientP12Password = p12Password ?? '';
    if (!p12Password && !tak.enroll) problems.push('TAK_CLIENT_P12_PASSWORD is required with TAK_CLIENT_P12');
  }
  if (!tak.enroll && !tak.clientP12Path) {
    problems.push(
      "Set TAK_USERNAME and TAK_PASSWORD (or TAK_ENROLL_URL, from TAK Portal's Enroll QR) so the bridge can enroll, " +
        'or TAK_CLIENT_P12 and TAK_CLIENT_P12_PASSWORD',
    );
  }

  const backendName = (env.CROWDCAD_BACKEND?.trim() || 'firebase').toLowerCase();
  let backend: BackendConfig;
  if (backendName === 'firebase') {
    backend = {
      kind: 'firebase',
      apiKey: str('FIREBASE_API_KEY'),
      projectId: str('FIREBASE_PROJECT_ID'),
      authDomain: str('FIREBASE_AUTH_DOMAIN'),
    };
  } else if (backendName === 'pocketbase') {
    backend = { kind: 'pocketbase', url: str('POCKETBASE_URL') };
  } else if (backendName === 'none') {
    backend = { kind: 'none' };
  } else {
    problems.push('CROWDCAD_BACKEND must be "firebase", "pocketbase" or "none"');
    backend = { kind: 'firebase', apiKey: '', projectId: '', authDomain: '' };
  }

  const levelName = (env.LOG_LEVEL?.trim() || 'info').toLowerCase();
  const logLevel = LOG_LEVELS.find((l) => l === levelName);
  if (!logLevel) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const needsAccount = backend.kind !== 'none';
  const config: BridgeConfig = {
    tak,
    dataDir: optional('BRIDGE_DATA_DIR') ?? './data',
    backend,
    bridgeEmail: needsAccount ? str('BRIDGE_EMAIL') : (optional('BRIDGE_EMAIL') ?? ''),
    bridgePassword: needsAccount ? str('BRIDGE_PASSWORD') : (optional('BRIDGE_PASSWORD') ?? ''),
    logLevel: logLevel ?? 'info',
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** A loggable view of the config with every secret removed. */
export function describeConfig(config: BridgeConfig): Record<string, unknown> {
  return {
    takHost: config.tak.host,
    takStreamPort: config.tak.streamPort,
    takIdentity: config.tak.enroll
      ? `enroll as ${config.tak.enroll.username} via ${config.tak.enroll.host}:${config.tak.enroll.port}`
      : `.p12 at ${config.tak.clientP12Path}`,
    takCa: config.tak.caPath ?? '(from enrollment or the .p12)',
    takServerName: config.tak.serverName ?? '(chain check against the TAK CA)',
    dataDir: config.dataDir,
    backend: config.backend.kind,
    backendTarget:
      config.backend.kind === 'firebase'
        ? config.backend.projectId
        : config.backend.kind === 'pocketbase'
          ? config.backend.url
          : '(none: log only)',
    bridgeEmail: config.bridgeEmail,
    logLevel: config.logLevel,
  };
}
