/**
 * Vitest global setup: one MongoDB server per `npm test` run.
 * Test files read its admin URI with `inject('mongoUri')`, normally through
 * `useTestDb()` in tests/helpers/db.ts.
 */
import type { TestProject } from 'vitest/node';
import { startTestServer } from './server.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin connection string for the shared test server. */
    mongoUri: string;
    mongoServerKind: 'memory' | 'external';
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const server = await startTestServer();
  project.provide('mongoUri', server.uri);
  project.provide('mongoServerKind', server.kind);
  return async () => {
    await server.stop();
  };
}
