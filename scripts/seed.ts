/**
 * npm run seed
 *
 * Connects as admin (MONGODB_URI), applies the schema, and upserts the demo
 * customers, orders, 12 tickets and the active policy from data/seed.
 * Safe to run any number of times; a second run reports everything unchanged.
 * With PAYMENTS=stripe, each ticket's order gets a fresh Stripe test payment instead
 * (so those orders are updated on every run).
 */
import { connectAdmin, loadConfigOrExit } from '@escrowops/shared';
import { seedPaymentHook } from './lib/payments.js';
import { formatSeedSummary, seedDatabase } from './lib/seed-data.js';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const createPayment = seedPaymentHook();
  const started = performance.now();
  const client = await connectAdmin(config);
  try {
    const summary = await seedDatabase(client.db(config.dbName), { createPayment });
    console.log(
      `Seeded database "${config.dbName}" in ${Math.round(performance.now() - started)} ms` +
        (createPayment ? ' (fresh Stripe test payments for ticket orders)' : ''),
    );
    console.log(formatSeedSummary(summary));
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
