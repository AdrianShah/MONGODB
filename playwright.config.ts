import { defineConfig, devices } from '@playwright/test';

// TEST_PLAN section 7: `npm run test:e2e`. Global setup builds the UI and starts the whole
// stack (in-memory MongoDB unless MONGODB_URI is set) with the dashboard on E2E_PORT.
const port = Number(process.env['E2E_PORT'] ?? 4199);

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.spec.ts',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
});
