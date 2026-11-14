/**
 * npm run demo:kill  (DEMO.md 2:40, "Kill the worker mid-payout")
 *
 * Tells the running executor (npm run executor, same machine) to SIGKILL itself on its next
 * payout, after the provider call and before the ledger update, then queues one approved
 * refund so that payout happens. Restart the executor and it reconciles: one refund, not two.
 */
import { hostname } from 'node:os';
import { COLLECTIONS, connectAdmin, loadConfigOrExit, ledgerSourceId, type LedgerDoc } from '@escrowops/shared';
import { findExecutor, isAlive, queueApprovedRefund, waitUntil } from './lib/demo.js';

async function main(): Promise<number> {
  const config = loadConfigOrExit();
  const client = await connectAdmin(config);
  try {
    const db = client.db(config.dbName);
    const executor = await findExecutor(db);
    if (!executor || !isAlive(executor.pid)) {
      console.error('No running executor found. Start it first: npm run executor');
      return 1;
    }
    if (executor.host !== hostname()) {
      console.error(`The executor is running on ${executor.host}; run demo:kill there.`);
      return 1;
    }

    process.kill(executor.pid, 'SIGUSR2');
    await new Promise((r) => setTimeout(r, 300)); // let it arm before the refund arrives
    const refund = await queueApprovedRefund(db);
    console.log(`Queued an approved $${(refund.amount_cents / 100).toFixed(2)} refund (${refund.ticket_id}, order ${refund.order_id}).`);
    console.log(`Executor ${executor.pid} will be killed after the provider call, before the ledger update...`);

    if (!(await waitUntil(() => !isAlive(executor.pid), 15_000))) {
      console.error('The executor did not crash within 15 s. Is it the process this database points at?');
      return 1;
    }
    const entry = await db
      .collection<LedgerDoc>(COLLECTIONS.ledger)
      .findOne({ source_id: ledgerSourceId('approved', refund._id) });
    console.log(`\nKilled. Ledger entry ${entry?.source_id}: ${entry?.status} (the provider has already been paid).`);
    console.log('Restart the executor (npm run executor): it reconciles this entry with the same key, so there is still one refund.');
    return 0;
  } finally {
    await client.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
