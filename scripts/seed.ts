/**
 * npm run seed
 *
 * Connects as admin (MONGODB_URI), applies the schema, and upserts the demo
 * customers, orders, 12 tickets and the active policy from data/seed.
 * Safe to run any number of times; a second run reports everything unchanged.
 */
import { connectAdmin, loadConfigOrExit } from '@escrowops/shared';
import { formatSeedSummary, seedDatabase } from './lib/seed-data.js';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const started = performance.now();
  const client = await connectAdmin(config);
  try {
    const summary = await seedDatabase(client.db(config.dbName));
    console.log(`Seeded database "${config.dbName}" in ${Math.round(performance.now() - started)} ms`);
    console.log(formatSeedSummary(summary));
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => {
  console.error(`seed failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
