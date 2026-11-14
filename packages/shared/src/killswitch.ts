/**
 * Kill switch: freeze the agent mid-run and roll back what it has not been paid for yet.
 *
 * The freeze is enforced by MongoDB, not by agent code:
 *
 *  1. `updateRole agent_role` replaces its privileges with the frozen set: the same reads, and
 *     insert on agent_traces (so the agent can still record why it stopped), but NO insert on
 *     `intents` or `review_queue`. The server invalidates the user cache, so the agent's very
 *     next proposal, on a connection it already holds, fails with Unauthorized (code 13).
 *  2. Every intent that has not been paid is voided by inserting a `failed` ledger tombstone
 *     with its `source_id`. The unique index on `ledger.source_id` then makes it impossible for
 *     the executor to claim it (its insert gets E11000 and it moves on). A pending entry whose
 *     pre-payout checks have not passed is voided with a compare-and-set on
 *     `{status: 'pending', checks_passed: false}`; the executor does the same CAS before it
 *     calls the provider, so exactly one of the two wins. An entry already past its checks is
 *     reported as in flight and never touched; a succeeded one is never touched.
 *  3. One append-only `kill_switch` record says who froze, when, why, which privileges were
 *     removed, and which intents were voided, so the audit timeline can reconstruct it.
 *
 * Unfreeze runs `updateRole` back to exactly ROLE_DEFINITIONS (roles.ts). Voided intents stay
 * voided: a rollback is not undone by unfreezing.
 *
 * Needs a connection that can run `updateRole` and write `ledger` and `kill_switch`: the admin
 * credentials in MONGODB_URI (as setup uses). No runtime role can do this; granting one
 * `grantRole`/`revokeRole` would let it grant itself anything. On Atlas, `updateRole` is
 * refused and RoleManagementRefusedError is thrown before anything is voided.
 */
import { MongoServerError, ObjectId, type Db, type Document, type MongoClient } from 'mongodb';
import { COLLECTIONS as C } from './collections.js';
import { ROLE_NAMES, RoleManagementRefusedError, roleDefinition, serverPrivileges, type Privilege } from './roles.js';
import { ledgerSourceId, type IntentDoc, type LedgerDoc } from './types.js';

/** What the agent loses while frozen. */
export const FROZEN_AGENT_REVOKES: readonly Privilege[] = Object.freeze([
  { collection: C.intents, actions: ['insert'] },
  { collection: C.review_queue, actions: ['insert'] },
]);

/** The ledger `owner` and `provider` of a tombstone written by the kill switch. */
export const KILL_SWITCH_OWNER = 'kill-switch';
export const VOIDED_REASON_PREFIX = 'voided_by_kill_switch';

export interface VoidedIntent {
  intent_id: ObjectId;
  source_id: string;
  trace_id: string;
  ticket_id: string;
  amount_cents: number;
  /** "no_ledger_entry": tombstone inserted; "pending_unchecked": a pending entry was CAS-voided. */
  how: 'no_ledger_entry' | 'pending_unchecked';
}

export interface InFlightIntent {
  source_id: string;
  trace_id: string;
  ticket_id: string;
  amount_cents: number;
}

/** One document in `kill_switch`. Append-only: written by the admin path, read by everyone. */
export interface KillSwitchDoc {
  _id: ObjectId;
  action: 'freeze' | 'unfreeze';
  /** Approver ID from the approval service session, or "cli:<user>" from the script. */
  actor: string;
  reason: string;
  at: Date;
  role: string;
  /** Privileges removed (freeze) or restored (unfreeze), in role-definition shape. */
  privileges_changed: Privilege[];
  /** Freeze only: intents that will never pay. */
  voided: VoidedIntent[];
  /** Freeze only: intents whose payout had already passed its checks; left to finish. */
  in_flight: InFlightIntent[];
  /** Trace IDs in `voided`, for the timeline's $unionWith. */
  voided_trace_ids: string[];
  /** True when the role was already in the requested state (the command still ran). */
  already: boolean;
}

export interface FreezeStatus {
  frozen: boolean;
  /** The latest kill_switch record, if any. */
  last?: KillSwitchDoc;
}

export interface KillSwitchRequest {
  actor: string;
  reason?: string;
}

/** The agent role's privileges while frozen: its definition minus FROZEN_AGENT_REVOKES. */
export function frozenAgentPrivileges(): Privilege[] {
  const out: Privilege[] = [];
  for (const p of roleDefinition('agent').privileges) {
    const revoked = FROZEN_AGENT_REVOKES.find((r) => r.collection === p.collection)?.actions ?? [];
    const actions = p.actions.filter((a) => !revoked.includes(a));
    if (actions.length) out.push({ collection: p.collection, actions });
  }
  return out;
}

async function updateAgentRole(admin: MongoClient, dbName: string, privileges: Privilege[]): Promise<void> {
  const def = { role: ROLE_NAMES.agent, privileges };
  try {
    await admin.db(dbName).command({ updateRole: ROLE_NAMES.agent, privileges: serverPrivileges(def, dbName), roles: [] });
  } catch (err) {
    if (err instanceof MongoServerError && (err.code === 13 || err.code === 8000 || err.codeName === 'AtlasError' || /CMD_NOT_ALLOWED|not allowed/i.test(err.message))) {
      throw new RoleManagementRefusedError('updateRole', err);
    }
    throw err;
  }
}

/** True when the agent role on the server lacks any of FROZEN_AGENT_REVOKES. Needs viewRole (admin). */
export async function agentRoleFrozen(admin: MongoClient, dbName: string): Promise<boolean> {
  const info = await admin.db(dbName).command({ rolesInfo: { role: ROLE_NAMES.agent, db: dbName }, showPrivileges: true });
  const role = ((info['roles'] ?? []) as Document[])[0];
  if (!role) throw new Error(`role ${ROLE_NAMES.agent} not found on ${dbName}; run npm run setup`);
  const privileges = (role['privileges'] ?? []) as Array<{ resource: { collection?: string }; actions: string[] }>;
  return FROZEN_AGENT_REVOKES.some((r) =>
    r.actions.some((a) => !privileges.some((p) => p.resource.collection === r.collection && p.actions.includes(a))),
  );
}

/** Freeze status as anyone with find on kill_switch sees it (the dashboard): the latest record. */
export async function loadFreezeStatus(db: Db): Promise<FreezeStatus> {
  const last = await db.collection<KillSwitchDoc>(C.kill_switch).findOne({}, { sort: { at: -1, _id: -1 } });
  return last ? { frozen: last.action === 'freeze', last } : { frozen: false };
}

/** Revoke the agent's proposal inserts, void every unpaid intent, and record it. */
export async function freezeAgent(admin: MongoClient, dbName: string, req: KillSwitchRequest): Promise<KillSwitchDoc> {
  const db = admin.db(dbName);
  const at = new Date();
  const already = await agentRoleFrozen(admin, dbName);
  // 1. Database-enforced stop. After this returns, no new intent can be inserted by the agent.
  await updateAgentRole(admin, dbName, frozenAgentPrivileges());

  // 2. Rollback. Runs after the revoke, so nothing can slip in behind the sweep.
  const recordId = new ObjectId();
  const reason = (req.reason ?? '').trim() || 'agent frozen';
  const failure = `${VOIDED_REASON_PREFIX}: agent frozen by ${req.actor} (${reason})`;
  const { voided, inFlight } = await voidUnpaidIntents(db, recordId, failure);

  // 3. Audit record.
  const doc: KillSwitchDoc = {
    _id: recordId,
    action: 'freeze',
    actor: req.actor,
    reason,
    at,
    role: ROLE_NAMES.agent,
    privileges_changed: FROZEN_AGENT_REVOKES.map((p) => ({ collection: p.collection, actions: [...p.actions] })),
    voided,
    in_flight: inFlight,
    voided_trace_ids: [...new Set(voided.map((v) => v.trace_id))],
    already,
  };
  await db.collection<KillSwitchDoc>(C.kill_switch).insertOne(doc);
  return doc;
}

/** Restore the agent role to exactly its ROLE_DEFINITIONS entry, and record it. */
export async function unfreezeAgent(admin: MongoClient, dbName: string, req: KillSwitchRequest): Promise<KillSwitchDoc> {
  const db = admin.db(dbName);
  const wasFrozen = await agentRoleFrozen(admin, dbName);
  await updateAgentRole(admin, dbName, roleDefinition('agent').privileges.map((p) => ({ collection: p.collection, actions: [...p.actions] })));
  const doc: KillSwitchDoc = {
    _id: new ObjectId(),
    action: 'unfreeze',
    actor: req.actor,
    reason: (req.reason ?? '').trim() || 'agent unfrozen',
    at: new Date(),
    role: ROLE_NAMES.agent,
    privileges_changed: FROZEN_AGENT_REVOKES.map((p) => ({ collection: p.collection, actions: [...p.actions] })),
    voided: [],
    in_flight: [],
    voided_trace_ids: [],
    already: !wasFrozen,
  };
  await db.collection<KillSwitchDoc>(C.kill_switch).insertOne(doc);
  return doc;
}

const isDuplicateKey = (err: unknown) => err instanceof MongoServerError && err.code === 11000;

async function voidUnpaidIntents(
  db: Db,
  recordId: ObjectId,
  failure: string,
): Promise<{ voided: VoidedIntent[]; inFlight: InFlightIntent[] }> {
  const ledger = db.collection<Omit<LedgerDoc, '_id'> & { _id?: ObjectId; voided_by?: ObjectId }>(C.ledger);
  const voided: VoidedIntent[] = [];
  const inFlight: InFlightIntent[] = [];
  const intents = db.collection<IntentDoc>(C.intents).find({}, { sort: { created_at: 1 } });

  for await (const intent of intents) {
    const sourceId = ledgerSourceId('intents', intent._id);
    const base = { source_id: sourceId, trace_id: intent.trace_id, ticket_id: intent.ticket_id, amount_cents: intent.amount_cents };
    const now = new Date();
    try {
      // Occupy the unique source_id slot so the executor can never claim this intent.
      await ledger.insertOne({
        source_id: sourceId,
        source_collection: 'intents',
        source_doc_id: intent._id,
        trace_id: intent.trace_id,
        ticket_id: intent.ticket_id,
        order_id: intent.order_id,
        customer_id: intent.customer_id,
        amount_cents: intent.amount_cents,
        currency: intent.currency,
        status: 'failed',
        checks_passed: false,
        owner: KILL_SWITCH_OWNER,
        attempts: 0,
        provider: KILL_SWITCH_OWNER,
        failure_reason: failure,
        voided_by: recordId,
        created_at: now,
        updated_at: now,
      });
      voided.push({ intent_id: intent._id, ...base, how: 'no_ledger_entry' });
      continue;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    // The executor already has an entry. Void it only if it has not passed its checks; the
    // executor's own CAS on the same filter decides the race.
    const res = await ledger.updateOne(
      { source_id: sourceId, status: 'pending', checks_passed: false },
      { $set: { status: 'failed', failure_reason: failure, voided_by: recordId, updated_at: now } },
    );
    if (res.modifiedCount === 1) {
      voided.push({ intent_id: intent._id, ...base, how: 'pending_unchecked' });
      continue;
    }
    const entry = await ledger.findOne({ source_id: sourceId }, { projection: { status: 1 } });
    if (entry?.status === 'pending') inFlight.push(base); // past its checks: may already be paid
    // succeeded or failed: nothing to roll back, never touched.
  }
  return { voided, inFlight };
}
