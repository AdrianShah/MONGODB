/**
 * Shared setup for the role tests: schema + roles + users on the file's own
 * database, and a Change Stream helper.
 */
import type { ChangeStream, Document } from 'mongodb';
import { applyRoles, applySchema, ensureUsers } from '@escrowops/shared';
import type { TestDb } from '../helpers/index.js';

export async function setUpAccess(t: TestDb): Promise<void> {
  await applySchema(t.db);
  await applyRoles(t.admin, t.dbName);
  await ensureUsers(t.admin, t.dbName, t.config.users);
}

/**
 * Open `stream` (surfacing any authorization error now, since watch() is
 * lazy), run `trigger`, then wait for the first event.
 */
export async function firstEvent(stream: ChangeStream, trigger: () => Promise<unknown>, timeoutMs = 15_000): Promise<Document> {
  try {
    const early = await stream.tryNext();
    if (early) return early;
    await trigger();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const event = await stream.tryNext();
      if (event) return event;
    }
    throw new Error('no change event within timeout');
  } finally {
    await stream.close();
  }
}
