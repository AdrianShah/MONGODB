import { defineConfig } from 'vitest/config';

// TEST_PLAN section 6: `npm run test:evals`. Uses the real model when ANTHROPIC_API_KEY is set.
export default defineConfig({
  test: {
    include: ['tests/evals/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 30 * 60_000,
    teardownTimeout: 60_000,
    fileParallelism: false,
  },
});
