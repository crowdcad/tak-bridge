// SPDX-License-Identifier: AGPL-3.0-only

import fs from 'node:fs';
import path from 'node:path';

/**
 * The security rules and PocketBase setup live in crowdcad/crowdcad. Emulator
 * and PocketBase tests read them from a checkout named by CROWDCAD_CORE_DIR
 * (CI checks out the integration/tak branch).
 */
export function coreDir(): string {
  const dir = process.env.CROWDCAD_CORE_DIR;
  if (!dir) throw new Error('Set CROWDCAD_CORE_DIR to a crowdcad/crowdcad checkout to run these tests.');
  return path.resolve(dir);
}

export function coreFile(relative: string): string {
  return fs.readFileSync(path.join(coreDir(), relative), 'utf8');
}
