/**
 * Kill switch from the terminal.
 *
 *   npm run freeze -- "reason"      revoke the agent's insert on intents/review_queue (updateRole),
 *                                   void every unpaid intent, record it in kill_switch
 *   npm run unfreeze -- "reason"    restore the agent role to exactly roles.ts
 *   npm run freeze -- --status      print whether the agent role is frozen on the server
 *
 * Connects with the admin credentials in MONGODB_URI, like setup. The same operation is behind
 * the dashboard's Freeze button (via the approval service, POST /api/freeze).
 *
 * Exit codes: 0 done, 1 error, 2 the server refused role management (e.g. Atlas).
 */
import { userInfo } from 'node:os';
import {
  RoleManagementRefusedError,
  agentRoleFrozen,
  connectAdmin,
  freezeAgent,
  loadConfigOrExit,
  loadFreezeStatus,
  unfreezeAgent,
} from '@escrowops/shared';

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const unfreeze = args.includes('--unfreeze');
  const statusOnly = args.includes('--status');
  const reason = args.filter((a) => !a.startsWith('--')).join(' ').trim() || undefined;
  const actor = `cli:${process.env['KILL_SWITCH_ACTOR'] ?? userInfo().username}`;

  const config = loadConfigOrExit();
  const admin = await connectAdmin(config, { serverSelectionTimeoutMS: 10_000 });
  try {
    if (statusOnly) {
      const frozen = await agentRoleFrozen(admin, config.dbName);
      const { last } = await loadFreezeStatus(admin.db(config.dbName));
      console.log(`agent role: ${frozen ? 'FROZEN' : 'active'}`);
      if (last) console.log(`last: ${last.action} by ${last.actor} at ${last.at.toISOString()} (${last.reason})`);
      return 0;
    }
    if (unfreeze) {
      const doc = await unfreezeAgent(admin, config.dbName, { actor, reason });
      console.log(`${doc.already ? 'Agent was not frozen; role re-applied' : 'Agent UNFROZEN'} by ${doc.actor}: agent_role restored to its definition in roles.ts`);
      console.log('Voided refunds stay voided.');
      return 0;
    }
    const doc = await freezeAgent(admin, config.dbName, { actor, reason });
    console.log(`Agent FROZEN by ${doc.actor}${doc.already ? ' (it was already frozen)' : ''}: ${doc.reason}`);
    console.log('  MongoDB revoked: insert on intents, insert on review_queue (updateRole agent_role)');
    console.log("  The agent's next proposal fails with MongoServerError code 13 (Unauthorized).");
    console.log(`  Voided ${doc.voided.length} unpaid intent(s); the executor can never claim them:`);
    for (const v of doc.voided) console.log(`    ${v.ticket_id.padEnd(8)} ${dollars(v.amount_cents).padStart(10)}  ${v.source_id}`);
    if (doc.in_flight.length) {
      console.log(`  ${doc.in_flight.length} payout(s) already past their checks were left to finish (may already be paid):`);
      for (const v of doc.in_flight) console.log(`    ${v.ticket_id.padEnd(8)} ${dollars(v.amount_cents).padStart(10)}  ${v.source_id}`);
    }
    console.log(`  Audit record: kill_switch ${doc._id.toHexString()}. Undo the freeze with \`npm run unfreeze\`.`);
    return 0;
  } catch (err) {
    if (err instanceof RoleManagementRefusedError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  } finally {
    await admin.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  },
);
