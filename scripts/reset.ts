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
 *
 * Kill switch: kill_switch records are run data and are cleared too; if the agent role is
 * still frozen, reset unfreezes it (and records that), so a repeat demo starts live.
 */
import { agentRoleFrozen, connectAdmin, loadConfigOrExit, unfreezeAgent } from '@escrowops/shared';
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
    try {
      if (await agentRoleFrozen(client, config.dbName)) {
        await unfreezeAgent(client, config.dbName, { actor: 'cli:reset', reason: 'npm run reset' });
        console.log('  kill switch agent was frozen; unfrozen (agent_role restored to roles.ts)');
      }
    } catch (err) {
      console.warn(`  kill switch could not check or restore agent_role: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`reset failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
