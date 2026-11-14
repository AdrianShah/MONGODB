/**
 * Kill switch from the terminal.
 *
 *   npm run agent:freeze -- "reason"    freeze: unsatisfiable validator on intents/review_queue
 *                                       (+ updateRole agent_role where allowed), void every
 *                                       unpaid intent and pending review, record it in kill_switch
 *   npm run agent:unfreeze -- "reason"  restore the validators (active policy) and agent_role
 *   npm run agent:freeze -- --status    print whether the agent is frozen on the server
 *   --no-role                           skip the updateRole layer (KILL_SWITCH_ROLE=off also does)
 *
 * Connects with the admin credentials in MONGODB_URI, like setup. The same operation is behind
 * the dashboard's Freeze button (via the approval service, POST /api/freeze).
 *
 * Exit codes: 0 done, 1 error. A server that refuses updateRole (Atlas) is not an error: the
 * validator layer still freezes the agent, and the record says why the role step was skipped.
 */
import { userInfo } from 'node:os';
import {
  agentFrozen,
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
  const revokeRole = !args.includes('--no-role') && !['0', 'off', 'false', 'no'].includes((process.env['KILL_SWITCH_ROLE'] ?? '').toLowerCase());
  const actor = `cli:${process.env['KILL_SWITCH_ACTOR'] ?? userInfo().username}`;

  const config = loadConfigOrExit();
  const admin = await connectAdmin(config, { serverSelectionTimeoutMS: 10_000 });
  try {
    if (statusOnly) {
      const frozen = await agentFrozen(admin.db(config.dbName));
      const { last } = await loadFreezeStatus(admin.db(config.dbName));
      console.log(`agent: ${frozen ? 'FROZEN' : 'active'}`);
      if (last) console.log(`last: ${last.action} by ${last.actor} at ${last.at.toISOString()} (${last.reason})`);
      return 0;
    }
    if (unfreeze) {
      const doc = await unfreezeAgent(admin, config.dbName, { actor, reason, revokeRole });
      console.log(`${doc.already ? 'Agent was not frozen; validators re-applied' : 'Agent UNFROZEN'} by ${doc.actor}: validators restored from the active policy`);
      console.log(doc.role_revoked ? '  agent_role restored to roles.ts' : `  role step skipped: ${doc.role_note ?? ''}`);
      console.log('Voided refunds stay voided.');
      return 0;
    }
    const doc = await freezeAgent(admin, config.dbName, { actor, reason, revokeRole });
    console.log(`Agent FROZEN by ${doc.actor}${doc.already ? ' (it was already frozen)' : ''}: ${doc.reason}`);
    console.log('  MongoDB validator: intents and review_queue now reject every insert (collMod)');
    console.log(
      doc.role_revoked
        ? "  agent_role: insert on intents/review_queue revoked; the agent's next proposal fails with code 13 (Unauthorized)"
        : `  agent_role unchanged (${doc.role_note ?? 'skipped'}); the agent's next proposal fails with code 121 (DocumentValidationFailure)`,
    );
    console.log(`  Voided ${doc.voided.length} unpaid intent(s); the executor can never claim them:`);
    if (doc.voided_reviews.length) console.log(`  Rejected ${doc.voided_reviews.length} pending review(s).`);
    for (const v of doc.voided) console.log(`    ${v.ticket_id.padEnd(8)} ${dollars(v.amount_cents).padStart(10)}  ${v.source_id}`);
    if (doc.in_flight.length) {
      console.log(`  ${doc.in_flight.length} payout(s) already past their checks were left to finish (may already be paid):`);
      for (const v of doc.in_flight) console.log(`    ${v.ticket_id.padEnd(8)} ${dollars(v.amount_cents).padStart(10)}  ${v.source_id}`);
    }
    console.log(`  Audit record: kill_switch ${doc._id.toHexString()}. Undo the freeze with \`npm run agent:unfreeze\`.`);
    return 0;
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
