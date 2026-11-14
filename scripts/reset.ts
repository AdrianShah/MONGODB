/**
 * npm run reset
 *
 * Clears all run data (intents, review_queue, approvals, approved, ledger,
 * agent_traces, executor_state, budgets) with deleteMany, keeping collections,
 * validators, indexes, roles and users, then re-seeds. Running processes keep
 * their Change Stream watchers: nothing is dropped.
 *
 * T4: a repeat run must create new refunds, not replay old ones. With PAYMENTS=stripe
 * the re-seed makes fresh test payments; with FAKE_PROVIDER_URL set, the fake
 * provider's refunds and call log are cleared.
 */
import { connectAdmin, loadConfigOrExit } from '@escrowops/shared';
import { clearFakeProvider, seedPaymentHook } from './lib/payments.js';
import { formatResetSummary, resetDatabase } from './lib/seed-data.js';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const createPayment = seedPaymentHook();
  const started = performance.now();
  const client = await connectAdmin(config);
  try {
    const summary = await resetDatabase(client.db(config.dbName), { createPayment });
    const fake = await clearFakeProvider();
    console.log(
      `Reset database "${config.dbName}" in ${Math.round(summary.durationMs)} ms (${Math.round(performance.now() - started)} ms including connect)`,
    );
    console.log(formatResetSummary(summary));
    if (createPayment) console.log('  payments   fresh Stripe test payments for ticket orders');
    console.log(`  fake provider ${fake}`);
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`reset failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
