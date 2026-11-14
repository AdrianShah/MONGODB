import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Chaos tests spawn and SIGKILL real processes; run them with `npm run test:chaos`.
    exclude: ['tests/chaos/**', '**/node_modules/**'],
    // One MongoDB server per run, shared through inject('mongoUri').
    globalSetup: ['tests/helpers/global-setup.ts'],
    // The first run downloads a mongod binary; replica set election and
    // auth setup take a few seconds after that.
    hookTimeout: 120_000,
    testTimeout: 60_000,
    teardownTimeout: 60_000,
    // Test files run in parallel; each gets its own database from useTestDb().
    pool: 'forks',
  },
});
