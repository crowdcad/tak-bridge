// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Inbound sources feed the bridge from the TAK side. v1 has one,
 * CotStreamSource (TLS CoT streaming on 8089, P1). TakCadPollerSource is a
 * documented stub for later (see takcad-poller.ts).
 */

/** A device position taken from a CoT `a-*` event. Coordinates are WGS84 decimal degrees. */
export interface DevicePosition {
  /** CoT event@uid, the stable device key. */
  deviceUid: string;
  /** Contact callsign, for display only. */
  callsign?: string;
  /** CoT event@type, e.g. a-f-G-U-C. */
  cotType: string;
  lat: number;
  lon: number;
  /** Height above ellipsoid in meters, when the device reports it. */
  hae?: number;
  /** Circular error in meters, when reported. */
  ce?: number;
  course?: number;
  speed?: number;
  /** CoT event@time, epoch ms. */
  deviceTime: number;
  /** When the bridge received it, epoch ms. */
  receivedAt: number;
}

export type InboundEvent = { kind: 'position'; position: DevicePosition };

export interface InboundSource {
  /** Short name used in logs and status, e.g. "cot-stream". */
  readonly name: string;
  /** Connects and starts delivering events. Reconnects on its own until stop() is called. */
  start(onEvent: (event: InboundEvent) => void): Promise<void>;
  stop(): Promise<void>;
  /** True while the source has a live connection. Reported in the bridge heartbeat. */
  isConnected(): boolean;
}
