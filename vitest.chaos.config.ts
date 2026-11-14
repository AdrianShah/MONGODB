import { defineConfig } from 'vitest/config';

// TEST_PLAN section 4. `npm run test:chaos`; CHAOS_RUNS sets C5's repeat count (default 50).
export default defineConfig({
  test: {
    include: ['tests/chaos/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    hookTimeout: 120_000,
    // Each test spawns and kills executor processes; C5 alone runs 50 rounds.
    testTimeout: 600_000,
    teardownTimeout: 60_000,
    fileParallelism: false,
  },
});
