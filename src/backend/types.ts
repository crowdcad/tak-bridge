// SPDX-License-Identifier: AGPL-3.0-only

import type { DevicePosition } from '../sources/types.js';

/**
 * One interface over Firebase (default) and PocketBase. Implementations land
 * in P2 and sign in as the bridge account with the client SDK, so the
 * backend's security rules apply to every call.
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
}

export type Unsubscribe = () => void;

export interface BackendAdapter {
  /** Signs in as the bridge account and returns its uid. */
  signIn(email: string, password: string): Promise<string>;
  /** Watches the TAK configs linked to this bridge. */
  watchLinkedEvents(onChange: (configs: TakEventConfig[]) => void): Unsubscribe;
  /** Watches one event's device links. */
  watchDeviceLinks(eventId: string, onChange: (links: DeviceLink[]) => void): Unsubscribe;
  writeLivePosition(eventId: string, position: DevicePosition): Promise<void>;
  deleteLivePositions(eventId: string, deviceUids?: string[]): Promise<void>;
  /** Live docs older than the cutoff, for the startup sweep. */
  listStaleLiveDevices(eventId: string, olderThan: number): Promise<string[]>;
  writeBridgeStatus(status: BridgeStatus): Promise<void>;
  writeEventStatus(
    eventId: string,
    status: { lastSeenAt: number; takConnected: boolean; liveDeviceCount: number },
  ): Promise<void>;
  // History writes (segments, windows, grid, detailed points) are added in P5.
}
