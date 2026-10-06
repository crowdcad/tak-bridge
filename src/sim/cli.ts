// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Simulation } from './model.js';
import { SimTakServer } from './server.js';

/**
 * Runs the CoT simulator as a stand-in TAK Server.
 *
 *   npm run dev-certs                      # once: throwaway certs in ./certs/dev
 *   npm run sim -- --devices 20 --hours 8 --speed 60
 *
 * Then point the bridge at it: TAK_HOST=localhost, TAK_STREAM_PORT=8089,
 * TAK_CLIENT_P12=certs/dev/client.p12, TAK_CLIENT_P12_PASSWORD=atakatak.
 */
const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8089' },
    host: { type: 'string', default: '127.0.0.1' },
    devices: { type: 'string', default: '20' },
    hours: { type: 'string', default: '8' },
    speed: { type: 'string', default: '1' },
    seed: { type: 'string', default: '1' },
    lat: { type: 'string', default: '37.8715' },
    lon: { type: 'string', default: '-122.2730' },
    certs: { type: 'string', default: 'certs/dev' },
    plain: { type: 'boolean', default: false },
    noise: { type: 'boolean', default: false },
  },
});

const certsDir = path.resolve(values.certs!);
const read = (name: string) => fs.readFileSync(path.join(certsDir, name), 'utf8');
const startTime = Date.now();
const durationMs = Number(values.hours) * 3_600_000;
const simulation = new Simulation({
  devices: Number(values.devices),
  startTime,
  center: { lat: Number(values.lat), lon: Number(values.lon) },
  seed: Number(values.seed),
});
const server = new SimTakServer({
  simulation,
  host: values.host,
  port: Number(values.port),
  speed: Number(values.speed),
  noise: values.noise,
  tls: values.plain ? undefined : { key: read('server.key'), cert: read('server.pem'), ca: read('ca.pem') },
});

const port = await server.listen();
process.stdout.write(
  `CoT simulator on ${values.host}:${port} (${values.plain ? 'plain TCP' : 'TLS'}), ` +
    `${values.devices} devices, ${values.hours} h at ${values.speed}x\n`,
);
const timer = setInterval(() => {
  const elapsed = simulation.now - startTime;
  process.stdout.write(
    `virtual ${(elapsed / 3_600_000).toFixed(2)} h, ${server.messagesSent} messages, ${server.clientCount} client(s)\n`,
  );
  if (elapsed >= durationMs) {
    clearInterval(timer);
    void server.close();
  }
}, 10_000);
process.once('SIGINT', () => {
  clearInterval(timer);
  void server.close();
});
