/**
 * npm run redteam [-- --fast] (PRD T3, DEMO.md 1:55)
 *
 * "Assume the agent is fully compromised." Connects with the AGENT user's
 * credentials only and runs the five demo attacks through `runRedTeam`
 * (@escrowops/shared/redteam, the same loop behind the dashboard's red-team
 * panel), printing one line per attack with the real server code. Then,
 * through a read-only (dashboard) connection, confirms nothing any attack
 * tried to write reached `approved`, `ledger` or `intents`, and prints
 * "Payouts caused: 0".
 *
 * Safe during a live demo with the executor watching `intents`: no attack
 * inserts a valid intent, and the forged documents point at an order that
 * does not exist. The footprint check matches only this run's documents
 * (by trace_id / _id), so legitimate payouts happening at the same time are
 * not counted.
 *
 * Exit code 1 if any attack was not refused, was refused with a different
 * code than expected (a regression in one layer), or anything it tried to
 * write is found afterwards.
 */
import type { MongoClient } from 'mongodb';
import { connectAs, loadConfigOrExit } from '@escrowops/shared';
import { formatAttackLine, runRedTeam } from '@escrowops/shared/redteam';

async function main(): Promise<number> {
  const config = loadConfigOrExit();
  const fast = process.argv.includes('--fast');
  const { username } = config.users.agent;

  let agent: MongoClient;
  let reader: MongoClient;
  try {
    agent = await connectAs('agent', config, { serverSelectionTimeoutMS: 10_000 });
    reader = await connectAs('dashboard', config, { serverSelectionTimeoutMS: 10_000 });
  } catch (err) {
    console.error(`Cannot log in as the agent or dashboard user: ${err instanceof Error ? err.message : String(err)}`);
    console.error('Run `npm run setup` first (on Atlas, see docs/ATLAS_SETUP.md).');
    return 1;
  }

  try {
    const { summary } = await runRedTeam({
      agentDb: agent.db(config.dbName),
      readDb: reader.db(config.dbName),
      agentUsername: username,
      pauseMs: fast ? 0 : 400,
      onEvent: (e) => {
        if (e.type === 'start') console.log(`Connected as ${e.username} (agent credentials only). Attacking database "${e.db}".\n`);
        if (e.type === 'result') console.log(formatAttackLine(e.index + 1, e.label, e.result));
      },
    });

    console.log(`\nPayouts caused: ${summary.landed.ledger}`);
    if (summary.ok) return 0;
    // A refusal with an unexpected code was still blocked, but by a different layer than the one
    // the demo claims (e.g. a role regression caught only by the validator). That fails the run too.
    console.error(summary.breached ? '\nGUARDRAIL FAILURE:' : '\nGUARDRAIL REGRESSION (blocked, but not by the expected rule):');
    for (const p of summary.problems) console.error(`  - ${p}`);
    return 1;
  } finally {
    await Promise.all([agent.close(), reader.close()]);
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
