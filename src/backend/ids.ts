// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Document ids for TAK device UIDs. Firestore ids can't contain "/" and
 * PocketBase filters need safe values, so device UIDs are stored as
 * encodeURIComponent(uid) and decoded by readers (data contract, Identifiers).
 */
export function deviceDocId(deviceUid: string): string {
  return encodeURIComponent(deviceUid);
}

export function deviceUidFromDocId(id: string): string {
  return decodeURIComponent(id);
}
