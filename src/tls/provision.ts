// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import type { TakConfig } from '../config.js';
import type { Logger } from '../log.js';
import {
  EnrollmentError,
  enroll as defaultEnroll,
  enrollmentUsable,
  loadEnrollment,
  saveEnrollment,
  type EnrolledIdentity,
  type EnrollOptions,
} from './enroll.js';
import { identityFromEnrollment, loadTlsIdentity, readCa, type TlsIdentity } from './identity.js';

/** Renew when the certificate has less than this long left. */
export const RENEW_WITHIN_MS = 30 * 24 * 3600_000;
/** How often to check whether renewal is due. */
export const RENEW_CHECK_MS = 12 * 3600_000;

export interface ProvisionDeps {
  enroll?: (o: EnrollOptions) => Promise<EnrolledIdentity>;
  now?: () => number;
  readFile?: (p: string) => Buffer;
}

export interface Provisioned {
  identity: TlsIdentity;
  /** Set when the identity came from enrollment. */
  enrolled?: EnrolledIdentity;
  /** True when a new certificate was requested on this call. */
  freshlyEnrolled: boolean;
}

/** The client UID the bridge enrolls under; stable per TAK username so TAK Server sees one device. */
export const clientUidFor = (username: string) => `crowdcad-bridge-${username}`;

/**
 * Works out the bridge's TLS identity:
 * - with TAK_USERNAME/TAK_PASSWORD (or TAK_ENROLL_URL): reuse the certificate
 *   saved in the data directory, or enroll for a new one and save it;
 * - otherwise: the TAK_CLIENT_P12 bundle.
 * If enrollment fails but a .p12 is also configured, the .p12 is used.
 */
export async function provisionIdentity(tak: TakConfig, dataDir: string, log: Logger, deps: ProvisionDeps = {}): Promise<Provisioned> {
  const now = deps.now ?? Date.now;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p));
  if (!tak.enroll) return { identity: loadTlsIdentity(tak, readFile), freshlyEnrolled: false };

  const { host, username } = tak.enroll;
  const saved = loadEnrollment(dataDir);
  if (enrollmentUsable(saved, host, username, now(), RENEW_WITHIN_MS)) {
    log.info('using saved TAK certificate', { username, expires: new Date(saved!.notAfter).toISOString() });
    return { identity: identityFromEnrollment(saved!, tak, readFile), enrolled: saved!, freshlyEnrolled: false };
  }

  try {
    const enrolled = await enrollNow(tak, deps);
    saveEnrollment(dataDir, enrolled);
    log.info('enrolled with TAK Server', { username, expires: new Date(enrolled.notAfter).toISOString(), dataDir });
    return { identity: identityFromEnrollment(enrolled, tak, readFile), enrolled, freshlyEnrolled: true };
  } catch (err) {
    // A saved certificate that is merely close to expiry is still better than nothing.
    if (saved && saved.host === host && saved.username === username && saved.notAfter > now()) {
      log.warn('could not renew the TAK certificate; using the saved one until it expires', {
        message: (err as Error).message,
        expires: new Date(saved.notAfter).toISOString(),
      });
      return { identity: identityFromEnrollment(saved, tak, readFile), enrolled: saved, freshlyEnrolled: false };
    }
    if (tak.clientP12Path) {
      log.warn('enrollment failed; falling back to TAK_CLIENT_P12', { message: (err as Error).message });
      return { identity: loadTlsIdentity(tak, readFile), freshlyEnrolled: false };
    }
    throw err;
  }
}

function enrollNow(tak: TakConfig, deps: ProvisionDeps): Promise<EnrolledIdentity> {
  const e = tak.enroll!;
  const ca = readCa(tak, deps.readFile);
  return (deps.enroll ?? defaultEnroll)({
    host: e.host,
    port: e.port,
    username: e.username,
    password: e.password,
    ...(ca.length ? { ca } : {}),
    clientUid: clientUidFor(e.username),
  });
}

/**
 * Checks periodically whether the enrolled certificate needs renewing, and if
 * so enrolls again and hands the new identity to onRenewed. Returns a stop
 * function. Renewal needs the TAK password to still work: a single-use token
 * from TAK Portal's Enroll QR won't, and the log says so.
 */
export function scheduleRenewal(
  tak: TakConfig,
  dataDir: string,
  log: Logger,
  current: EnrolledIdentity,
  onRenewed: (identity: TlsIdentity) => void,
  deps: ProvisionDeps & { checkEveryMs?: number } = {},
): () => void {
  const now = deps.now ?? Date.now;
  let enrolled = current;
  let running = false;
  const check = async () => {
    if (running || enrolled.notAfter - now() > RENEW_WITHIN_MS) return;
    running = true;
    try {
      const next = await enrollNow(tak, deps);
      saveEnrollment(dataDir, next);
      enrolled = next;
      log.info('renewed the TAK certificate', { expires: new Date(next.notAfter).toISOString() });
      onRenewed(identityFromEnrollment(next, tak, deps.readFile));
    } catch (err) {
      const hint =
        err instanceof EnrollmentError && (err.status === 401 || err.status === 403)
          ? ' If TAK_PASSWORD is a one-time Enroll QR token, set the TAK user\'s real password (or a new token) and restart.'
          : '';
      log.warn(`could not renew the TAK certificate.${hint}`, {
        message: (err as Error).message,
        expires: new Date(enrolled.notAfter).toISOString(),
      });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void check(), deps.checkEveryMs ?? RENEW_CHECK_MS);
  timer.unref();
  void check();
  return () => clearInterval(timer);
}
