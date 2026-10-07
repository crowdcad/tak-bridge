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

const without = (env: Record<string, string>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !keys.includes(k)));

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
    expect(config.tak.caPath).toBeUndefined();
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

  it('allows a log-only config with no backend or bridge account', () => {
    const config = loadConfig({ TAK_HOST: 'tak.example.org', TAK_CLIENT_P12_PASSWORD: 'x', CROWDCAD_BACKEND: 'none' });
    expect(config.backend).toEqual({ kind: 'none' });
    expect(config.bridgeEmail).toBe('');
  });

  it('reports every missing variable at once', () => {
    expect(problemsOf({})).toEqual(
      expect.arrayContaining([
        'TAK_HOST is required',
        expect.stringMatching(/^Set TAK_USERNAME and TAK_PASSWORD .* or TAK_CLIENT_P12/),
        'FIREBASE_API_KEY is required',
        'FIREBASE_PROJECT_ID is required',
        'FIREBASE_AUTH_DOMAIN is required',
        'BRIDGE_EMAIL is required',
        'BRIDGE_PASSWORD is required',
      ]),
    );
  });

  it('enrolls with TAK_USERNAME and TAK_PASSWORD, needing no .p12', () => {
    const rest = without(firebaseEnv, 'TAK_CLIENT_P12_PASSWORD');
    const config = loadConfig({ ...rest, TAK_USERNAME: 'crowdcad-bridge', TAK_PASSWORD: 'tak-secret' });
    expect(config.tak.enroll).toEqual({ host: 'tak.example.org', port: 8446, username: 'crowdcad-bridge', password: 'tak-secret' });
    expect(config.tak.clientP12Path).toBeUndefined();
    expect(config.dataDir).toBe('./data');
  });

  it('takes host, username and token from an Enroll QR link', () => {
    const rest = without(firebaseEnv, 'TAK_HOST', 'TAK_CLIENT_P12_PASSWORD');
    const config = loadConfig({
      ...rest,
      TAK_ENROLL_URL: 'tak://com.atakmap.app/enroll?host=takserver.example.org&username=bridge&token=tok-secret',
      TAK_ENROLL_PORT: '9446',
      BRIDGE_DATA_DIR: '/data',
    });
    expect(config.tak.host).toBe('takserver.example.org');
    expect(config.tak.enroll).toEqual({ host: 'takserver.example.org', port: 9446, username: 'bridge', password: 'tok-secret' });
    expect(config.dataDir).toBe('/data');
    expect(problemsOf({ ...rest, TAK_ENROLL_URL: 'nonsense' })).toContain(
      'TAK_ENROLL_URL is not a TAK enrollment link (expected ...?host=...&username=...&token=...)',
    );
  });

  it('lets TAK_ENROLL_HOST differ from TAK_HOST', () => {
    const config = loadConfig({ ...firebaseEnv, TAK_USERNAME: 'u', TAK_PASSWORD: 'p', TAK_ENROLL_HOST: 'enroll.example.org' });
    expect(config.tak.enroll?.host).toBe('enroll.example.org');
    expect(config.tak.clientP12Path).toBe('/certs/client.p12'); // kept as a fallback
  });

  it('needs both TAK_USERNAME and TAK_PASSWORD', () => {
    expect(problemsOf({ ...firebaseEnv, TAK_USERNAME: 'u' })).toContain('TAK_USERNAME and TAK_PASSWORD must both be set to enroll');
  });

  it('rejects bad ports, backends and log levels', () => {
    const problems = problemsOf({
      ...firebaseEnv,
      TAK_STREAM_PORT: '99999',
      CROWDCAD_BACKEND: 'mysql',
      LOG_LEVEL: 'loud',
    });
    expect(problems).toContain('TAK_STREAM_PORT must be a port number (1-65535)');
    expect(problems).toContain('CROWDCAD_BACKEND must be "firebase", "pocketbase" or "none"');
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
        loadConfig({ ...firebaseEnv, TAK_STREAM_PORT: 'p12-secret', TAK_USERNAME: 'u' });
      } catch (e) {
        return e as Error;
      }
      throw new Error('expected a ConfigError');
    })();
    expect(err.message).not.toContain('p12-secret');

    const summary = JSON.stringify(describeConfig(loadConfig({ ...firebaseEnv, TAK_USERNAME: 'u', TAK_PASSWORD: 'tak-secret' })));
    for (const secret of ['p12-secret', 'api-key-secret', 'bridge-secret', 'tak-secret']) {
      expect(summary).not.toContain(secret);
    }
  });
});
