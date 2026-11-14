/**
 * npm run audit:verify  (S9)
 *
 * Recomputes every hash chain: the agent's trace for each run, and the approvals of each
 * review. Exits 1 and names the record if anything was changed, inserted or deleted after it
 * was written. Reads as the dashboard user (read-only).
 */
import { connectAs, loadConfigOrExit, verifyAll } from '@escrowops/shared';

async function main(): Promise<number> {
  const config = loadConfigOrExit();
  const client = await connectAs('dashboard', config);
  try {
    const report = await verifyAll(client.db(config.dbName));
    console.log(`Checked ${report.records} records in ${report.traces} agent traces and ${report.reviews} approval chains.`);
    if (report.problems.length === 0) {
      console.log('Every chain verifies: nothing was changed after it was written.');
      return 0;
    }
    console.error(`\nTAMPERING DETECTED in ${new Set(report.problems.map((p) => p.chain)).size} chain(s):`);
    for (const p of report.problems) console.error(`  - ${p.chain}: ${p.problem}`);
    return 1;
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
