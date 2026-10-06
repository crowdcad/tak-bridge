// SPDX-License-Identifier: AGPL-3.0-only

import net from 'node:net';
import tls from 'node:tls';
import { CotFramer } from '../cot/framing.js';
import { buildOtherCot, buildPositionCot } from '../cot/xml.js';
import { Simulation, prng } from './model.js';

/**
 * A stand-in for a TAK Server's streaming endpoint. It accepts TLS (or plain
 * TCP, for quick local tests) and streams a Simulation's positions as CoT to
 * every connected client.
 *
 * - speed: virtual seconds per real second. 1 is real time; 60 plays an
 *   8-hour event in 8 minutes.
 * - noise: also sends chat, map pins, tasking and 0,0 placeholders, which the
 *   bridge must ignore.
 * - fragment: splits writes at random byte boundaries, to exercise framing.
 * - Answers client t-x-c-t pings with t-x-c-t-r, like TAK Server.
 */
export interface SimServerOptions {
  simulation: Simulation;
  port?: number;
  host?: string;
  /** PEM server key and certificate, plus the CA that signed client certificates. Omit for plain TCP. */
  tls?: { key: string; cert: string; ca: string };
  speed?: number;
  tickMs?: number;
  noise?: boolean;
  fragment?: boolean;
}

export class SimTakServer {
  private server: net.Server | null = null;
  private readonly clients = new Set<net.Socket>();
  private timer: NodeJS.Timeout | null = null;
  private lastReal = 0;
  private readonly rand = prng(7);
  private sent = 0;

  constructor(private readonly options: SimServerOptions) {}

  /** Number of CoT messages written so far, across all clients. */
  get messagesSent(): number {
    return this.sent;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  async listen(): Promise<number> {
    const onSocket = (socket: net.Socket) => this.accept(socket);
    const o = this.options;
    this.server = o.tls
      ? tls.createServer({ key: o.tls.key, cert: o.tls.cert, ca: o.tls.ca, requestCert: true, rejectUnauthorized: true }, onSocket)
      : net.createServer(onSocket);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(o.port ?? 0, o.host ?? '127.0.0.1', () => resolve());
    });
    this.lastReal = Date.now();
    this.timer = setInterval(() => this.tick(), o.tickMs ?? 100);
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  /** Drops every client connection but keeps listening, to test reconnects. */
  dropClients(): void {
    for (const c of this.clients) c.destroy();
    this.clients.clear();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.dropClients();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  private accept(socket: net.Socket): void {
    this.clients.add(socket);
    socket.setEncoding('utf8');
    const framer = new CotFramer();
    socket.on('data', (chunk: string) => {
      for (const msg of framer.push(chunk)) {
        if (msg.includes('type="t-x-c-t"')) {
          this.write(socket, buildOtherCot({ uid: 'takPong', type: 't-x-c-t-r', time: Date.now() }));
        }
      }
    });
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  }

  private tick(): void {
    const realNow = Date.now();
    const elapsed = realNow - this.lastReal;
    this.lastReal = realNow;
    const sim = this.options.simulation;
    const fixes = sim.fixesBetween(sim.now + elapsed * (this.options.speed ?? 1));
    if (this.clients.size === 0) return;

    let out = '';
    for (const f of fixes) {
      out += buildPositionCot({
        uid: f.deviceUid,
        callsign: f.callsign,
        lat: f.lat,
        lon: f.lon,
        ce: f.ce,
        course: f.course,
        speed: f.speed,
        time: f.deviceTime,
      });
      this.sent++;
      if (this.options.noise && this.rand() < 0.1) {
        out += this.noiseEvent(f.deviceTime, f.lat, f.lon);
        this.sent++;
      }
    }
    if (out) for (const c of this.clients) this.write(c, out);
  }

  private noiseEvent(time: number, lat: number, lon: number): string {
    const pick = Math.floor(this.rand() * 4);
    if (pick === 0) return buildOtherCot({ uid: `GeoChat.${time}`, type: 'b-t-f', time });
    if (pick === 1) return buildOtherCot({ uid: `pin-${time}`, type: 'b-m-p-s-p-i', lat, lon, time });
    if (pick === 2) return buildOtherCot({ uid: `task-${time}`, type: 't-x-d-d', time });
    return buildPositionCot({ uid: `ZERO-${time}`, lat: 0, lon: 0, time });
  }

  private write(socket: net.Socket, data: string): void {
    if (!this.options.fragment) {
      socket.write(data);
      return;
    }
    let i = 0;
    while (i < data.length) {
      const n = 1 + Math.floor(this.rand() * 400);
      socket.write(data.slice(i, i + n));
      i += n;
    }
  }
}
