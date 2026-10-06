// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from './config.js';

const firebaseEnv = {
  TAK_HOST: 'tak.example.org',
  TAK_CLIENT_P12_PASSWORD: 'p12-secret',
  FIREBASE_API_KEY: 'api-key-secret',
  FIREBASE_PROJECT_ID: 'demo-project',
  FIREBASE_AUTH_DOMAIN: 'demo-project.firebaseapp.com',
  BRIDGE_EMAIL: 'abc123@bridge.crowdcad.org',
  BRIDGE_PASSWORD: 'bridge-secret',
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('loads a Firebase config with defaults', () => {
    const config = loadConfig(firebaseEnv);
    expect(config.backend).toEqual({
      kind: 'firebase',
      apiKey: 'api-key-secret',
      projectId: 'demo-project',
      authDomain: 'demo-project.firebaseapp.com',
    });
    expect(config.tak.streamPort).toBe(8089);
    expect(config.tak.apiPort).toBe(8443);
    expect(config.tak.clientP12Path).toBe('/certs/client.p12');
    expect(config.tak.caPath).toBe('/certs/ca.pem');
    expect(config.logLevel).toBe('info');
  });

  it('loads a PocketBase config without Firebase settings', () => {
    const config = loadConfig({
      TAK_HOST: 'tak.example.org',
      TAK_CLIENT_P12_PASSWORD: 'x',
      CROWDCAD_BACKEND: 'pocketbase',
      POCKETBASE_URL: 'http://pocketbase:8090',
      BRIDGE_EMAIL: 'b@example.org',
      BRIDGE_PASSWORD: 'y',
    });
    expect(config.backend).toEqual({ kind: 'pocketbase', url: 'http://pocketbase:8090' });
  });

  it('reports every missing variable at once', () => {
    expect(problemsOf({})).toEqual(
      expect.arrayContaining([
        'TAK_HOST is required',
        'TAK_CLIENT_P12_PASSWORD is required',
        'FIREBASE_API_KEY is required',
        'FIREBASE_PROJECT_ID is required',
        'FIREBASE_AUTH_DOMAIN is required',
        'BRIDGE_EMAIL is required',
        'BRIDGE_PASSWORD is required',
      ]),
    );
  });

  it('rejects bad ports, backends and log levels', () => {
    const problems = problemsOf({
      ...firebaseEnv,
      TAK_STREAM_PORT: '99999',
      CROWDCAD_BACKEND: 'mysql',
      LOG_LEVEL: 'loud',
    });
    expect(problems).toContain('TAK_STREAM_PORT must be a port number (1-65535)');
    expect(problems).toContain('CROWDCAD_BACKEND must be "firebase" or "pocketbase"');
    expect(problems).toContain('LOG_LEVEL must be one of debug, info, warn, error');
  });

  it('treats blank values as missing', () => {
    expect(problemsOf({ ...firebaseEnv, BRIDGE_PASSWORD: '   ' })).toEqual([
      'BRIDGE_PASSWORD is required',
    ]);
  });

  it('never puts secret values in errors or in the loggable summary', () => {
    const err = (() => {
      try {
        loadConfig({ ...firebaseEnv, TAK_STREAM_PORT: 'p12-secret' });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a ConfigError');
    })();
    expect(err.message).not.toContain('p12-secret');

    const summary = JSON.stringify(describeConfig(loadConfig(firebaseEnv)));
    for (const secret of ['p12-secret', 'api-key-secret', 'bridge-secret']) {
      expect(summary).not.toContain(secret);
    }
  });
});
