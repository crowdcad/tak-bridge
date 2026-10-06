// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Bridge configuration, read from the environment (see .env.example).
 *
 * Validation collects every problem before failing, so an operator sees all
 * missing or invalid variables at once. Error messages name variables only and
 * never include their values, since several of them are secrets.
 */

export type BackendKind = 'firebase' | 'pocketbase';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TakConfig {
  host: string;
  /** TLS CoT streaming port. */
  streamPort: number;
  /** TAK Server API port. Reserved for the TAK-CAD poller; unused in v1. */
  apiPort: number;
  /** Path to the bridge user's client certificate bundle (.p12). */
  clientP12Path: string;
  clientP12Password: string;
  /** Path to the TAK Server CA: a PEM file or a truststore .p12. */
  caPath: string;
  /** Only needed when caPath is a .p12. */
  caP12Password?: string;
  /** Optional TLS server name override, when the certificate name differs from host. */
  serverName?: string;
}

export type BackendConfig =
  | { kind: 'firebase'; apiKey: string; projectId: string; authDomain: string }
  | { kind: 'pocketbase'; url: string };

export interface BridgeConfig {
  tak: TakConfig;
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

  const tak: TakConfig = {
    host: str('TAK_HOST'),
    streamPort: port('TAK_STREAM_PORT', 8089),
    apiPort: port('TAK_API_PORT', 8443),
    clientP12Path: str('TAK_CLIENT_P12', '/certs/client.p12'),
    clientP12Password: str('TAK_CLIENT_P12_PASSWORD'),
    caPath: str('TAK_CA', '/certs/ca.pem'),
    caP12Password: optional('TAK_CA_P12_PASSWORD'),
    serverName: optional('TAK_SERVER_NAME'),
  };

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
  } else {
    problems.push('CROWDCAD_BACKEND must be "firebase" or "pocketbase"');
    backend = { kind: 'firebase', apiKey: '', projectId: '', authDomain: '' };
  }

  const levelName = (env.LOG_LEVEL?.trim() || 'info').toLowerCase();
  const logLevel = LOG_LEVELS.find((l) => l === levelName);
  if (!logLevel) problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const config: BridgeConfig = {
    tak,
    backend,
    bridgeEmail: str('BRIDGE_EMAIL'),
    bridgePassword: str('BRIDGE_PASSWORD'),
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
    takClientP12: config.tak.clientP12Path,
    takCa: config.tak.caPath,
    backend: config.backend.kind,
    backendTarget:
      config.backend.kind === 'firebase' ? config.backend.projectId : config.backend.url,
    bridgeEmail: config.bridgeEmail,
    logLevel: config.logLevel,
  };
}
