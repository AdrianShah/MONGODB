/**
 * Kill switch: freeze the agent mid-run and roll back what it has not been paid for yet.
 *
 * The freeze is enforced by MongoDB, not by agent code, in two layers:
 *
 *  1. Validator (always; works on Atlas, which refuses updateRole from a database connection):
 *     `collMod` puts an unsatisfiable `$jsonSchema` (title FROZEN_VALIDATOR_TITLE) on `intents`
 *     and `review_queue`. The agent's very next proposal fails with DocumentValidationFailure
 *     (121), and the errInfo names the kill switch, who froze it and when. applySchema leaves a
 *     frozen validator alone, so re-running setup or apply-policy cannot silently unfreeze.
 *  2. Role (best effort, local mongod / self-managed): `updateRole agent_role` drops insert on
 *     intents and review_queue, so the agent gets Unauthorized (13) before validation even runs.
 *     Refused (Atlas) or missing role: skipped and recorded in `role_note`, never an error.
 *
 * Rollback: every intent that has not been paid is voided by inserting a `failed` ledger
 * tombstone with its `source_id` (the unique index then stops the executor from claiming it),
 * or by a compare-and-set on a pending entry whose checks have not passed (the executor does the
 * same CAS before calling the provider, so exactly one wins). Entries past their checks are
 * reported as in flight; paid ones are never touched. Pending reviews are marked rejected.
 *
 * Audit: one append-only `kill_switch` record per freeze/unfreeze: actor (the approver from the
 * session, or cli:<user>), reason, enforcement layers, and every voided intent and review.
 *
 * Unfreeze restores the validators from the active policy and the role from roles.ts. Voided
 * refunds stay voided. Needs the admin connection (MONGODB_URI, collMod + ledger writes).
 */
import { MongoServerError, ObjectId, type Db, type Document, type MongoClient } from 'mongodb';
import { COLLECTIONS as C } from './collections.js';
import { ROLE_NAMES, RoleManagementRefusedError, roleDefinition, serverPrivileges, type Privilege } from './roles.js';
import { DEFAULT_POLICY, type Policy } from './policy.js';
import { FROZEN_VALIDATOR_TITLE, buildValidators } from './schema.js';

import { ledgerSourceId, type IntentDoc, type LedgerDoc, type PolicyDoc, type ReviewQueueDoc } from './types.js';

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
  /** What enforced it: always the collection validator; plus the role where updateRole is allowed. */
  enforcement: Array<'validator' | 'role'>;
  role_revoked: boolean;
  /** Why the role step was skipped (Atlas refuses updateRole from a database connection). */
  role_note?: string;
  /** Privileges removed (freeze) or restored (unfreeze), in role-definition shape. */
  privileges_changed: Privilege[];
  /** Freeze only: intents that will never pay. */
  voided: VoidedIntent[];
  /** Freeze only: pending reviews marked rejected so no one can approve them. */
  voided_reviews: VoidedReview[];
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
  /** Also run updateRole on agent_role (default true; skipped gracefully where refused, e.g. Atlas). */
  revokeRole?: boolean;
}

export interface VoidedReview {
  review_id: ObjectId;
  trace_id: string;
  ticket_id: string;
  amount_cents: number;
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

/**
 * Layer 1 (works everywhere, including Atlas): the validator that makes every insert into
 * `intents` and `review_queue` fail with DocumentValidationFailure (121). `not: {}` matches no
 * document, so no field the agent could add satisfies it. review_queue gets validationLevel
 * "moderate" so approvers can still update (reject, void) the reviews already in it.
 */
export const FROZEN_COLLECTIONS = [C.intents, C.review_queue] as const;

export function frozenValidator(actor: string, at: Date): Document {
  return {
    $jsonSchema: {
      title: FROZEN_VALIDATOR_TITLE,
      description: `frozen by ${actor} at ${at.toISOString()}; no new refund proposals until unfrozen`,
      not: {},
    },
  };
}

/** True when a stored validator is the kill switch's. */
export function isFrozenValidator(validator: unknown): boolean {
  return (validator as Document | undefined)?.['$jsonSchema']?.['title'] === FROZEN_VALIDATOR_TITLE;
}

/** True when `err` is the 121 the frozen validator produces (the agent's stop signal on Atlas). */
export function isFrozenValidationError(err: unknown): boolean {
  if (!(err instanceof MongoServerError) || err.code !== 121) return false;
  return JSON.stringify(err.errInfo ?? {}).includes(FROZEN_VALIDATOR_TITLE);
}

/** Freeze state as the database enforces it: the validator on `intents`. Needs listCollections. */
export async function agentFrozen(db: Db): Promise<boolean> {
  const [info] = await db.listCollections({ name: C.intents }, { nameOnly: false }).toArray();
  return isFrozenValidator(((info as Document | undefined)?.['options'] as Document | undefined)?.['validator']);
}

async function activePolicy(db: Db): Promise<Policy> {
  const doc = await db.collection<PolicyDoc>(C.policies).findOne({ active: true }, { sort: { version: -1 } });
  if (!doc) return { ...DEFAULT_POLICY };
  return {
    version: doc.version,
    auto_cap_cents: doc.auto_cap_cents,
    single_approver_cap_cents: doc.single_approver_cap_cents,
    hard_cap_cents: doc.hard_cap_cents,
  };
}

async function setFrozenValidators(db: Db, frozen: { actor: string; at: Date } | null): Promise<void> {
  if (frozen) {
    const validator = frozenValidator(frozen.actor, frozen.at);
    await db.command({ collMod: C.intents, validator, validationLevel: 'strict', validationAction: 'error' });
    await db.command({ collMod: C.review_queue, validator, validationLevel: 'moderate', validationAction: 'error' });
    return;
  }
  const normal = buildValidators(await activePolicy(db));
  for (const name of FROZEN_COLLECTIONS) {
    await db.command({ collMod: name, validator: normal[name] ?? {}, validationLevel: 'strict', validationAction: 'error' });
  }
}

/**
 * Layer 2 (optional): revoke the agent role's inserts. Skipped, not failed, where the server
 * refuses role management (Atlas) or the role does not exist; the validator still holds.
 */
async function tryUpdateAgentRole(
  admin: MongoClient,
  dbName: string,
  privileges: Privilege[],
  enabled: boolean,
): Promise<{ role_revoked: boolean; role_note?: string }> {
  if (!enabled) return { role_revoked: false, role_note: 'role revocation disabled' };
  try {
    await updateAgentRole(admin, dbName, privileges);
    return { role_revoked: true };
  } catch (err) {
    if (err instanceof RoleManagementRefusedError) return { role_revoked: false, role_note: err.message };
    if (err instanceof MongoServerError && err.code === 31) return { role_revoked: false, role_note: `role ${ROLE_NAMES.agent} not found` };
    throw err;
  }
}

/** Freeze the agent (validator, then role), void every unpaid refund, and record it. */
export async function freezeAgent(admin: MongoClient, dbName: string, req: KillSwitchRequest): Promise<KillSwitchDoc> {
  const db = admin.db(dbName);
  const at = new Date();
  const already = await agentFrozen(db);
  // 1. Database-enforced stop. After this returns, no new intent can be inserted by the agent.
  await setFrozenValidators(db, { actor: req.actor, at });
  const role = await tryUpdateAgentRole(admin, dbName, frozenAgentPrivileges(), req.revokeRole ?? true);

  // 2. Rollback. Runs after the stop, so nothing can slip in behind the sweep.
  const recordId = new ObjectId();
  const reason = (req.reason ?? '').trim() || 'agent frozen';
  const failure = `${VOIDED_REASON_PREFIX}: agent frozen by ${req.actor} (${reason})`;
  const { voided, inFlight } = await voidUnpaidIntents(db, recordId, failure);
  const voidedReviews = await voidPendingReviews(db, recordId, failure);

  // 3. Audit record.
  const doc: KillSwitchDoc = {
    _id: recordId,
    action: 'freeze',
    actor: req.actor,
    reason,
    at,
    role: ROLE_NAMES.agent,
    enforcement: ['validator', ...(role.role_revoked ? (['role'] as const) : [])],
    ...role,
    privileges_changed: FROZEN_AGENT_REVOKES.map((p) => ({ collection: p.collection, actions: [...p.actions] })),
    voided,
    voided_reviews: voidedReviews,
    in_flight: inFlight,
    voided_trace_ids: [...new Set([...voided.map((v) => v.trace_id), ...voidedReviews.map((v) => v.trace_id)])],
    already,
  };
  await db.collection<KillSwitchDoc>(C.kill_switch).insertOne(doc);
  return doc;
}

/** Restore the validators (active policy) and the agent role (roles.ts), and record it. */
export async function unfreezeAgent(admin: MongoClient, dbName: string, req: KillSwitchRequest): Promise<KillSwitchDoc> {
  const db = admin.db(dbName);
  const wasFrozen = await agentFrozen(db);
  await setFrozenValidators(db, null);
  const role = await tryUpdateAgentRole(
    admin,
    dbName,
    roleDefinition('agent').privileges.map((p) => ({ collection: p.collection, actions: [...p.actions] })),
    req.revokeRole ?? true,
  );
  const doc: KillSwitchDoc = {
    _id: new ObjectId(),
    action: 'unfreeze',
    actor: req.actor,
    reason: (req.reason ?? '').trim() || 'agent unfrozen',
    at: new Date(),
    role: ROLE_NAMES.agent,
    enforcement: ['validator', ...(role.role_revoked ? (['role'] as const) : [])],
    ...role,
    privileges_changed: FROZEN_AGENT_REVOKES.map((p) => ({ collection: p.collection, actions: [...p.actions] })),
    voided: [],
    voided_reviews: [],
    in_flight: [],
    voided_trace_ids: [],
    already: !wasFrozen,
  };
  await db.collection<KillSwitchDoc>(C.kill_switch).insertOne(doc);
  return doc;
}

/** Pending reviews will never be approved: mark them rejected, tied to the freeze record. */
async function voidPendingReviews(db: Db, recordId: ObjectId, failure: string): Promise<VoidedReview[]> {
  const reviews = db.collection<ReviewQueueDoc>(C.review_queue);
  const pending = await reviews.find({ status: 'pending' }).toArray();
  const out: VoidedReview[] = [];
  for (const r of pending) {
    const res = await reviews.updateOne(
      { _id: r._id, status: 'pending' },
      { $set: { status: 'rejected', voided_by: recordId, void_reason: failure, updated_at: new Date() } },
    );
    if (res.modifiedCount === 1) out.push({ review_id: r._id, trace_id: r.trace_id, ticket_id: r.ticket_id, amount_cents: r.amount_cents });
  }
  return out;
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
