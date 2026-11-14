/**
 * Test harness entry point.
 *
 *   import { useTestDb } from '../helpers/index.js';
 *
 *   const t = useTestDb('roles');          // registers beforeAll/afterAll
 *   it('...', async () => {
 *     await applySchema(t().db);
 *     const agent = await t().clientAs('escrow_agent', 'agent-dev-password');
 *   });
 *
 * Each call to useTestDb gives the test file its own uniquely named database
 * on the one server started by global-setup.ts.
 */
import { afterAll, beforeAll, inject } from 'vitest';
import { createTestDb, type TestDb } from './test-db.js';

export * from './test-db.js';
export * from './errors.js';

/** Admin URI of the shared test server (from global setup). */
export function testServerUri(): string {
  return inject('mongoUri');
}

/**
 * Create a fresh database before the file's tests run and drop it (with its
 * users and roles) afterwards. Returns an accessor; call it inside tests or
 * hooks, not at module top level.
 */
export function useTestDb(prefix = 't'): () => TestDb {
  let current: TestDb | undefined;
  beforeAll(async () => {
    current = await createTestDb(testServerUri(), prefix);
  });
  afterAll(async () => {
    await current?.cleanup();
  });
  return () => {
    if (!current) throw new Error('useTestDb(): database not ready; call the accessor inside a test or hook');
    return current;
  };
}
