// SPDX-License-Identifier: AGPL-3.0-only

import type { HistorySegmentDoc, PointsChunk } from '../history/recorder.js';
import type { DevicePosition } from '../sources/types.js';

/**
 * One interface over Firebase (default) and PocketBase. Both implementations
 * sign in as the bridge account with the client SDK, so the backend's security
 * rules apply to every call.
 *
 * The bridge never reads event documents. It reads only the records below,
 * as defined in crowdcad/crowdcad docs/tak-integration/data-contract.md.
 */

export type HistoryMode = 'off' | 'summary' | 'detailed';

/** An event's TAK config, the only per-event record the bridge reads besides device links. */
export interface TakEventConfig {
  eventId: string;
  bridgeUid: string | null;
  enabled: boolean;
  closed: boolean;
  historyMode: HistoryMode;
}

export interface DeviceLink {
  deviceUid: string;
  /** Opaque team id. The bridge never sees team names. */
  teamId: string;
  linkedAt: number;
  method: 'auto' | 'manual';
}

export interface BridgeStatus {
  lastSeenAt: number;
  takConnected: boolean;
  version: string;
  linkedEventCount: number;
  /** Distinct TAK devices seen since the bridge started. */
  devicesSeen: number;
  /** When the last position arrived from TAK, or 0. */
  lastPositionAt: number;
  /** The last TAK connection problem, in plain words, or empty when connected. Never contains secrets. */
  takError: string;
}

export interface EventStatus {
  lastSeenAt: number;
  takConnected: boolean;
  liveDeviceCount: number;
}

export type Unsubscribe = () => void;

export interface BackendAdapter {
  /** Signs in as the bridge account and returns its uid. */
  signIn(email: string, password: string): Promise<string>;
  /** Watches the TAK configs linked to this bridge. Called with the full current set on every change. */
  watchLinkedEvents(onChange: (configs: TakEventConfig[]) => void, onError: (err: Error) => void): Unsubscribe;
  /** Watches one event's device links. */
  watchDeviceLinks(eventId: string, onChange: (links: DeviceLink[]) => void, onError: (err: Error) => void): Unsubscribe;
  writeLivePosition(eventId: string, position: DevicePosition): Promise<void>;
  /** Deletes the given devices' live docs, or every live doc of the event when deviceUids is omitted. */
  deleteLivePositions(eventId: string, deviceUids?: string[]): Promise<void>;
  /** Devices whose live doc was last received before the cutoff, for the startup sweep. */
  listStaleLiveDevices(eventId: string, olderThan: number): Promise<string[]>;
  writeBridgeStatus(status: BridgeStatus): Promise<void>;
  writeEventStatus(eventId: string, status: EventStatus): Promise<void>;
  /** Watches which teams are on a call (opaque ids), published by dispatchers for Detailed history. */
  watchCallState(eventId: string, onChange: (teamIds: string[]) => void, onError: (err: Error) => void): Unsubscribe;
  /** Creates or replaces a history segment doc. */
  writeHistorySegment(eventId: string, segment: HistorySegmentDoc): Promise<void>;
  /** Writes one chunk of Detailed-mode points for a segment. */
  writeHistoryPoints(eventId: string, chunk: PointsChunk): Promise<void>;
  /** Signs out and releases connections. */
  close(): Promise<void>;
}

/** The fields of a live doc, as the data contract defines them. */
export function liveDoc(position: DevicePosition, bridgeUid: string): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    lat: position.lat,
    lon: position.lon,
    cotType: position.cotType,
    deviceTime: position.deviceTime,
    receivedAt: position.receivedAt,
    bridgeUid,
  };
  for (const key of ['hae', 'ce', 'course', 'speed', 'callsign'] as const) {
    if (position[key] !== undefined) doc[key] = position[key];
  }
  return doc;
}
