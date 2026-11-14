/**
 * npm run redteam [-- --fast] (PRD T3, DEMO.md 1:55)
 *
 * "Assume the agent is fully compromised." Connects with the AGENT user's
 * credentials only and runs the five demo attacks from
 * scripts/lib/redteam-attacks.ts, printing one line per attack with the real
 * server code. Then, through a read-only (dashboard) connection, confirms
 * nothing any attack tried to write reached `approved`, `ledger` or
 * `intents`, and prints "Payouts caused: 0".
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
import { setTimeout as sleep } from 'node:timers/promises';
import type { MongoClient, ObjectId } from 'mongodb';
import { COLLECTIONS, connectAs, loadConfigOrExit } from '@escrowops/shared';
import {
  attackFootprint,
  demoAttacks,
  formatAttackLine,
  newAttackContext,
  runAttack,
  type AttackResult,
} from './lib/redteam-attacks.js';

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
    const readDb = reader.db(config.dbName);
    // The agent cannot read intents, so the target for "edit an earlier refund" comes from the read-only user.
    const target = await readDb
      .collection<{ _id: ObjectId; amount_cents?: number }>(COLLECTIONS.intents)
      .findOne({}, { sort: { _id: -1 }, projection: { _id: 1, amount_cents: 1 } });

    const ctx = newAttackContext(agent.db(config.dbName), target ? { targetIntentId: target._id } : {});
    console.log(`Connected as ${username} (agent credentials only). Attacking database "${config.dbName}".\n`);

    const results: AttackResult[] = [];
    const attacks = demoAttacks();
    for (const [i, attack] of attacks.entries()) {
      const result = await runAttack(attack, ctx);
      results.push(result);
      console.log(formatAttackLine(i + 1, attack.label, result));
      if (!fast && i < attacks.length - 1) await sleep(400);
    }

    // Verify with a separate, read-only identity.
    const footprint = attackFootprint(ctx);
    const landed = {
      approved: await readDb.collection(COLLECTIONS.approved).countDocuments(footprint),
      ledger: await readDb.collection(COLLECTIONS.ledger).countDocuments(footprint),
      intents: await readDb.collection(COLLECTIONS.intents).countDocuments(footprint),
    };
    let targetEdited = false;
    if (target) {
      const after = await readDb
        .collection<{ _id: ObjectId; amount_cents?: number }>(COLLECTIONS.intents)
        .findOne({ _id: target._id }, { projection: { amount_cents: 1 } });
      targetEdited = after?.amount_cents !== target.amount_cents;
    }

    console.log(`\nPayouts caused: ${landed.ledger}`);

    const allowed = results.filter((r) => !r.denied);
    const problems: string[] = [];
    for (const r of allowed) problems.push(`${r.id} (${r.name}) was NOT refused by the server`);
    for (const r of results.filter((x) => x.denied && !x.asExpected)) {
      problems.push(`${r.id} was refused with code ${String(r.code)}, expected ${r.expectedCode}`);
    }
    if (landed.approved > 0) problems.push(`${landed.approved} forged document(s) found in approved`);
    if (landed.intents > 0) problems.push(`${landed.intents} forged document(s) found in intents`);
    if (landed.ledger > 0) problems.push(`${landed.ledger} ledger entr(ies) tied to this run`);
    if (targetEdited) problems.push(`the earlier intent ${target?._id.toHexString() ?? ''} was modified`);

    if (problems.length === 0) return 0;
    // A refusal with an unexpected code was still blocked, but by a different layer than the one
    // the demo claims (e.g. a role regression caught only by the validator). That fails the run too.
    const breached = allowed.length > 0 || landed.approved + landed.intents + landed.ledger > 0 || targetEdited;
    console.error(breached ? '\nGUARDRAIL FAILURE:' : '\nGUARDRAIL REGRESSION (blocked, but not by the expected rule):');
    for (const p of problems) console.error(`  - ${p}`);
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
