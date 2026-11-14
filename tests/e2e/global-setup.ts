/** Builds the UI and starts the full stack once for the e2e run; tests read its address from a state file. */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { startTestServer } from '../helpers/server.js';
import { startStack } from '../helpers/stack.js';

export const STATE_FILE = 'test-results/e2e-stack.json';

export interface E2EState {
  uri: string;
  dbName: string;
  dashboardUrl: string;
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  execSync('npm run build -w @escrowops/web', { stdio: 'inherit' });
  const server = await startTestServer();
  const stack = await startStack(server.uri, { prefix: 'e2e', dashboardPort: Number(process.env['E2E_PORT'] ?? 4199) });
  const state: E2EState = { uri: server.uri, dbName: stack.t.dbName, dashboardUrl: stack.dashboardUrl };
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state));
  return async () => {
    await stack.stop();
    await server.stop();
  };
}
