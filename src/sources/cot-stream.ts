// SPDX-License-Identifier: AGPL-3.0-only

import tls from 'node:tls';
import { CotFramer } from '../cot/framing.js';
import { buildPing, parseCot } from '../cot/xml.js';
import type { Logger } from '../log.js';
import { tlsConnectOptions, type TlsIdentity } from '../tls/identity.js';
import type { InboundEvent, InboundSource } from './types.js';

export interface CotStreamOptions {
  host: string;
  port: number;
  identity: TlsIdentity;
  log: Logger;
  /** UID the bridge uses for its own pings. */
  uid?: string;
  pingIntervalMs?: number;
  /** Reconnect if nothing at all arrives for this long. */
  idleTimeoutMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How long a connection must stay up before the backoff resets. */
  stableAfterMs?: number;
}

/**
 * TLS CoT streaming client for TAK Server's 8089 port.
 *
 * Connects with the bridge's client certificate, frames and parses the CoT
 * stream, and delivers `a-*` positions. It sends a t-x-c-t ping on an
 * interval, treats a silent connection as dead, and reconnects with
 * exponential backoff and jitter until stop() is called.
 */
export class CotStreamSource implements InboundSource {
  readonly name = 'cot-stream';
  private socket: tls.TLSSocket | null = null;
  private connected = false;
  private stopped = true;
  private backoffMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private onEvent: (event: InboundEvent) => void = () => {};
  private readonly opts: Required<Omit<CotStreamOptions, 'identity' | 'log'>> & Pick<CotStreamOptions, 'identity' | 'log'>;

  /** Counters, for status and tests. */
  readonly stats = { connects: 0, positions: 0, ignored: 0, invalid: 0 };
  /** The last connection problem, for status; cleared once connected. */
  lastError = '';

  constructor(options: CotStreamOptions) {
    this.opts = {
      uid: 'crowdcad-bridge',
      pingIntervalMs: 15_000,
      idleTimeoutMs: 60_000,
      minBackoffMs: 1_000,
      maxBackoffMs: 60_000,
      stableAfterMs: 10_000,
      ...options,
    };
    this.backoffMs = this.opts.minBackoffMs;
  }

  async start(onEvent: (event: InboundEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Switches to a new TLS identity (e.g. a renewed certificate) and reconnects. */
  updateIdentity(identity: TlsIdentity): void {
    this.opts.identity = identity;
    this.socket?.destroy();
  }

  private connect(): void {
    if (this.stopped) return;
    const { host, port, log } = this.opts;
    const framer = new CotFramer();
    const socket = tls.connect({ host, port, ...tlsConnectOptions(this.opts.identity) });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setKeepAlive(true, 30_000);

    socket.once('secureConnect', () => {
      this.connected = true;
      this.lastError = '';
      this.stats.connects++;
      log.info('connected to TAK Server', { host, port });
      this.pingTimer = setInterval(() => socket.write(buildPing(this.opts.uid)), this.opts.pingIntervalMs);
      this.stableTimer = setTimeout(() => (this.backoffMs = this.opts.minBackoffMs), this.opts.stableAfterMs);
      this.resetIdle(socket);
    });

    socket.on('data', (chunk: string) => {
      this.resetIdle(socket);
      const now = Date.now();
      for (const xml of framer.push(chunk)) {
        const parsed = parseCot(xml, now);
        if (parsed.kind === 'position') {
          this.stats.positions++;
          this.onEvent({ kind: 'position', position: parsed.position });
        } else if (parsed.kind === 'ignored') {
          this.stats.ignored++;
          log.debug('ignored CoT event', { type: parsed.type, reason: parsed.reason });
        } else {
          this.stats.invalid++;
          log.debug('invalid CoT message', { reason: parsed.reason });
        }
      }
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      this.lastError = describeTlsError(err);
      log.warn('TAK connection error', { code: err.code, message: err.message, hint: this.lastError });
    });

    socket.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.clearTimers();
      if (this.socket === socket) this.socket = null;
      if (this.stopped) return;
      const delay = Math.round(this.backoffMs * (0.75 + Math.random() * 0.5));
      log.warn(wasConnected ? 'TAK connection closed, reconnecting' : 'could not connect to TAK Server, retrying', {
        inMs: delay,
      });
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  private resetIdle(socket: tls.TLSSocket): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.opts.log.warn('no data from TAK Server, reconnecting', { idleMs: this.opts.idleTimeoutMs });
      socket.destroy();
    }, this.opts.idleTimeoutMs);
  }

  private clearTimers(): void {
    for (const t of [this.pingTimer, this.idleTimer]) if (t) clearInterval(t);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    this.pingTimer = this.idleTimer = this.stableTimer = null;
  }
}

/** A plain-words explanation of a TAK connection error, for logs and the CrowdCAD status checklist. */
export function describeTlsError(err: NodeJS.ErrnoException): string {
  const code = err.code ?? '';
  if (code === 'ECONNREFUSED') return 'Connection refused: check TAK_HOST and TAK_STREAM_PORT (usually 8089).';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'TAK_HOST could not be found (DNS).';
  if (code === 'ETIMEDOUT') return 'Timed out reaching the TAK Server: check the host, port and any firewall.';
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') return "The server certificate's name doesn't match: set TAK_SERVER_NAME to the name in it, or unset it.";
  if (/UNABLE_TO_VERIFY|SELF_SIGNED|UNABLE_TO_GET_ISSUER|CERT_UNTRUSTED/.test(code)) {
    return "The TAK Server's certificate isn't trusted: enroll again, or set TAK_CA to the TAK Server CA (PEM).";
  }
  if (/CERT_HAS_EXPIRED/.test(code)) return 'A certificate has expired: re-enroll the bridge (delete the data folder and restart).';
  if (/alert|handshake|bad certificate|certificate unknown/i.test(err.message)) {
    return 'The TAK Server rejected the bridge certificate: check the TAK user exists and is enabled, then re-enroll.';
  }
  return err.message;
}
