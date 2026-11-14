/**
 * npm run reset
 *
 * Clears all run data (intents, review_queue, approvals, approved, ledger,
 * agent_traces, executor_state, budgets) with deleteMany, keeping collections,
 * validators, indexes, roles and users, then re-seeds. Running processes keep
 * their Change Stream watchers: nothing is dropped.
 */
import { connectAdmin, loadConfigOrExit } from '@escrowops/shared';
import { formatResetSummary, resetDatabase } from './lib/seed-data.js';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const started = performance.now();
  const client = await connectAdmin(config);
  try {
    const summary = await resetDatabase(client.db(config.dbName));
    console.log(
      `Reset database "${config.dbName}" in ${Math.round(summary.durationMs)} ms (${Math.round(performance.now() - started)} ms including connect)`,
    );
    console.log(formatResetSummary(summary));
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`reset failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
