// SPDX-License-Identifier: AGPL-3.0-only
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.emulator.test.ts', 'src/**/*.pocketbase.test.ts'],
        },
      },
      {
        // Run with `npm run test:emulator` (Firestore + Auth emulators) and
        // CROWDCAD_CORE_DIR pointing at a crowdcad/crowdcad checkout.
        test: {
          name: 'emulator',
          include: ['src/**/*.emulator.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
          fileParallelism: false,
        },
      },
      {
        // Run with `npm run test:pocketbase` against a local PocketBase set up
        // by crowdcad/crowdcad's scripts/setup-pocketbase.js.
        test: {
          name: 'pocketbase',
          include: ['src/**/*.pocketbase.test.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
