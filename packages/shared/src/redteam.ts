/**
 * The agent red-team attack set (TEST_PLAN section 2, R1 to R10), as data
 * plus functions, and `runRedTeam`, the run-then-verify loop. Shared by
 * tests/roles/agent-attacks.test.ts, scripts/redteam.ts (`npm run redteam`)
 * and the approval service's POST /api/redteam/run (the dashboard's red-team
 * panel), so the stage demo runs exactly what the tests assert.
 *
 * Every attack runs against a `Db` handle opened with the AGENT user's
 * credentials. `runAttack` turns the outcome into an AttackResult: an attack
 * is `denied` when the server refused it with a MongoServerError. Anything
 * that is not a server error (network, a bug in an attack) is rethrown, so a
 * crash is never reported as a refusal.
 *
 * Demo safety: every forged document points at an order and customer that do
 * not exist (`REDTEAM-...`), carries the run's `trace_id` marker, and uses a
 * fresh idempotency key. Only R10 inserts a VALID intent (its first half);
 * it is flagged `insertsValidIntent` and is not part of DEMO_ATTACKS, so
 * neither `npm run redteam` nor the dashboard panel ever hands a live payout
 * worker a payable intent.
 */
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { MongoServerError, ObjectId, type Db, type Document } from 'mongodb';
import { COLLECTIONS } from './collections.js';
import { DEFAULT_POLICY } from './policy.js';
import { ROLE_NAMES } from './roles.js';
import { ledgerSourceId, type ApprovedDoc, type IntentDoc, type LedgerDoc } from './types.js';
import type { AttackId, AttackResult, RedTeamEvent, RedTeamSummary } from './redteam-events.js';

export type * from './redteam-events.js';

/** Server error codes the attacks are refused with. */
export const SERVER_ERROR_CODES = {
  /** Unauthorized: the user's roles lack the action. */
  UNAUTHORIZED: 13,
  /** DocumentValidationFailure: a validator rejected the write. */
  DOCUMENT_VALIDATION_FAILURE: 121,
  /** DuplicateKey (E11000): a unique index rejected the write. */
  DUPLICATE_KEY: 11000,
} as const;

export interface AttackContext {
  /** Database handle opened as the agent user. */
  db: Db;
  /** Marker for this run: the `trace_id` on every forged document. */
  runId: string;
  /** An existing intent to try to edit (R4). A random `_id` is used when absent. */
  targetIntentId?: ObjectId;
  /** An existing agent_traces document to try to delete (R7). A random `_id` is used when absent. */
  targetTraceId?: ObjectId;
  /** `_id`s of every document an attack tried to write, filled in as attacks run. */
  attemptedIds: ObjectId[];
}

export interface Attack {
  id: AttackId;
  /** One-line description, as used in test names. */
  name: string;
  /** Short label for the `npm run redteam` line. */
  label: string;
  /** What the compromised agent sends to the server, in one line (shown in the dashboard panel). */
  tried: string;
  /** Server error code the attack must be refused with. */
  expectedCode: number;
  /** True when a successful step of the attack writes a payable intent (R10's first half). */
  insertsValidIntent: boolean;
  run(ctx: AttackContext): Promise<unknown>;
}

/** $50,000: one hundred times the auto-refund cap. */
export const OVERSIZED_CENTS = 5_000_000;

export function newRunId(): string {
  return `redteam-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomBytes(3).toString('hex')}`;
}

export function newAttackContext(db: Db, targets: Pick<AttackContext, 'targetIntentId' | 'targetTraceId'> = {}): AttackContext {
  return { db, runId: newRunId(), attemptedIds: [], ...targets };
}

export interface ProposalOptions {
  amount_cents: number;
  trace_id: string;
  ticket_id?: string;
  order_id?: string;
  customer_id?: string;
  idempotency_key?: string;
  reason?: string;
}

/**
 * A refund proposal with exactly the fields the `intents` validator allows.
 * Valid if `amount_cents` is within the auto cap. Defaults point at an order
 * and customer that do not exist, so the executor's pre-payout check (E5)
 * would also refuse it.
 */
export function buildIntent(opts: ProposalOptions): IntentDoc {
  return {
    _id: new ObjectId(),
    trace_id: opts.trace_id,
    ticket_id: opts.ticket_id ?? 'REDTEAM-TICKET',
    order_id: opts.order_id ?? 'REDTEAM-NO-SUCH-ORDER',
    customer_id: opts.customer_id ?? 'REDTEAM-NO-SUCH-CUSTOMER',
    amount_cents: opts.amount_cents,
    currency: 'usd',
    reason: opts.reason ?? 'Red-team probe: this proposal must never be paid out.',
    evidence: [{ kind: 'note', note: 'red-team probe' }],
    policy_version: DEFAULT_POLICY.version,
    idempotency_key: opts.idempotency_key ?? `redteam-${randomBytes(8).toString('hex')}`,
    created_at: new Date(),
  };
}

/** An `approved` document. Valid for the validator when approvals fit the tier. */
export function buildApproved(opts: ProposalOptions & { review_id?: ObjectId; approver_ids: string[] }): ApprovedDoc {
  return {
    ...buildIntent(opts),
    review_id: opts.review_id ?? new ObjectId(),
    approvals: opts.approver_ids.map((approver_id) => ({ approver_id, approved_at: new Date() })),
  };
}

function track<T extends { _id: ObjectId }>(ctx: AttackContext, doc: T): T {
  ctx.attemptedIds.push(doc._id);
  return doc;
}

const { UNAUTHORIZED, DOCUMENT_VALIDATION_FAILURE, DUPLICATE_KEY } = SERVER_ERROR_CODES;

/** The server's codeName for each code above. */
const CODE_NAMES: Record<number, string> = {
  [UNAUTHORIZED]: 'Unauthorized',
  [DOCUMENT_VALIDATION_FAILURE]: 'DocumentValidationFailure',
  [DUPLICATE_KEY]: 'DuplicateKey',
};

/** R1 to R10, in TEST_PLAN order. */
export const AGENT_ATTACKS: readonly Attack[] = Object.freeze<Attack[]>([
  {
    id: 'R1',
    name: 'insert a $50,000 intent',
    label: 'Insert $50,000 refund',
    tried: 'insertOne into intents with amount_cents: 5000000 ($50,000, 100x the auto cap)',
    expectedCode: DOCUMENT_VALIDATION_FAILURE,
    insertsValidIntent: false,
    run: (ctx) =>
      ctx.db.collection(COLLECTIONS.intents).insertOne(track(ctx, buildIntent({ amount_cents: OVERSIZED_CENTS, trace_id: ctx.runId }))),
  },
  {
    id: 'R2',
    name: 'insert directly into approved with forged approvals',
    label: 'Forge two approvals, write to `approved`',
    tried: 'insertOne into approved: a $5,000 refund "signed" by approver-a and approver-b',
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) =>
      ctx.db.collection(COLLECTIONS.approved).insertOne(
        track(ctx, buildApproved({ amount_cents: 500_000, trace_id: ctx.runId, approver_ids: ['approver-a', 'approver-b'] })),
      ),
  },
  {
    id: 'R3',
    name: 'insert into approvals',
    label: 'Record an approval',
    tried: "insertOne into approvals: decision 'approve' as approver-a",
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) =>
      ctx.db.collection(COLLECTIONS.approvals).insertOne(
        track(ctx, { _id: new ObjectId(), review_id: new ObjectId(), approver_id: 'approver-a', decision: 'approve', created_at: new Date() }),
      ),
  },
  {
    id: 'R4',
    name: "update an existing intent's amount_cents",
    label: "Edit an earlier refund's amount",
    tried: 'updateOne on intents: $set amount_cents: 5000000 on the latest proposal',
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    // Authorization is checked before matching, so a random _id is refused too.
    run: (ctx) =>
      ctx.db
        .collection(COLLECTIONS.intents)
        .updateOne({ _id: ctx.targetIntentId ?? new ObjectId() }, { $set: { amount_cents: OVERSIZED_CENTS } }),
  },
  {
    id: 'R5',
    name: 'collMod on intents to remove the validator',
    label: 'Remove the validator (collMod)',
    tried: "collMod intents with validator: {} and validationLevel: 'off'",
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) => ctx.db.command({ collMod: COLLECTIONS.intents, validator: {}, validationLevel: 'off' }),
  },
  {
    id: 'R6',
    name: 'insert a $50,000 intent with bypassDocumentValidation',
    label: 'Insert with bypassDocumentValidation',
    tried: 'insertOne into intents, $50,000, with bypassDocumentValidation: true',
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) =>
      ctx.db
        .collection(COLLECTIONS.intents)
        .insertOne(track(ctx, buildIntent({ amount_cents: OVERSIZED_CENTS, trace_id: ctx.runId })), { bypassDocumentValidation: true }),
  },
  {
    id: 'R7',
    name: 'delete an agent_traces document',
    label: 'Delete its own trace',
    tried: 'deleteOne from agent_traces',
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) => ctx.db.collection(COLLECTIONS.agent_traces).deleteOne({ _id: ctx.targetTraceId ?? new ObjectId() }),
  },
  {
    id: 'R8',
    name: 'insert into ledger',
    label: 'Write a payout to the ledger',
    tried: "insertOne into ledger: a $50,000 payout marked 'succeeded'",
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) => {
      const sourceDocId = new ObjectId();
      const entry: LedgerDoc = {
        _id: new ObjectId(),
        source_id: ledgerSourceId('intents', sourceDocId),
        source_collection: 'intents',
        source_doc_id: sourceDocId,
        trace_id: ctx.runId,
        ticket_id: `REDTEAM-LEDGER-${randomBytes(4).toString('hex')}`,
        order_id: 'REDTEAM-NO-SUCH-ORDER',
        customer_id: 'REDTEAM-NO-SUCH-CUSTOMER',
        amount_cents: OVERSIZED_CENTS,
        currency: 'usd',
        status: 'succeeded',
        checks_passed: true,
        owner: 'redteam',
        attempts: 1,
        provider: 'stripe',
        provider_refund_id: 're_forged',
        created_at: new Date(),
        updated_at: new Date(),
      };
      return ctx.db.collection(COLLECTIONS.ledger).insertOne(track(ctx, entry));
    },
  },
  {
    id: 'R9',
    name: 'read executor_state',
    label: "Read the executor's resume tokens",
    tried: 'findOne on executor_state',
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) => ctx.db.collection(COLLECTIONS.executor_state).findOne({}),
  },
  {
    id: 'R10',
    name: 'split one $900 refund into two $450 intents for the same ticket and order',
    label: 'Split $900 into two $450 refunds',
    tried: 'insertOne into intents twice, $450 each, same ticket, order and idempotency key',
    expectedCode: DUPLICATE_KEY,
    insertsValidIntent: true,
    run: async (ctx) => {
      const ticket_id = `REDTEAM-SPLIT-${ctx.runId}`;
      const order_id = 'REDTEAM-NO-SUCH-ORDER';
      // A4: the key is a hash of ticket and order, so both halves share it.
      const idempotency_key = createHash('sha256').update(`${ticket_id}|${order_id}`).digest('hex');
      const same = { trace_id: ctx.runId, ticket_id, order_id, idempotency_key, amount_cents: 45_000 };
      const intents = ctx.db.collection(COLLECTIONS.intents);
      try {
        // The first half is a legitimate, valid proposal.
        await intents.insertOne(track(ctx, buildIntent(same)));
      } catch (err) {
        // Not a refusal of the attack: the setup step failed.
        throw new Error(`R10 setup: the first $450 half was rejected: ${err instanceof Error ? err.message : String(err)}`);
      }
      return intents.insertOne(track(ctx, buildIntent(same)));
    },
  },
]);

/** The five attacks `npm run redteam` and the dashboard panel show, in DEMO.md order. None inserts a payable intent. */
export const DEMO_ATTACK_IDS: readonly AttackId[] = ['R1', 'R2', 'R4', 'R5', 'R6'];

export function attackById(id: AttackId): Attack {
  const attack = AGENT_ATTACKS.find((a) => a.id === id);
  if (!attack) throw new Error(`Unknown attack ${id}`);
  return attack;
}

export function demoAttacks(): Attack[] {
  return DEMO_ATTACK_IDS.map(attackById);
}

function firstLine(text: string, max: number): string {
  const line = text.split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/** Short reason for one line of output. */
export function shortServerMessage(err: MongoServerError): string {
  switch (err.code) {
    case UNAUTHORIZED:
      return 'not authorized';
    case DOCUMENT_VALIDATION_FAILURE:
      return 'Document failed validation';
    case DUPLICATE_KEY:
      return 'E11000 duplicate key error';
    default:
      return firstLine(err.errmsg ?? err.message, 60);
  }
}

export async function runAttack(attack: Attack, ctx: AttackContext): Promise<AttackResult> {
  const base = { id: attack.id, name: attack.name, expectedCode: attack.expectedCode };
  try {
    await attack.run(ctx);
  } catch (err) {
    if (!(err instanceof MongoServerError)) throw err;
    const code = typeof err.code === 'number' ? err.code : undefined;
    return {
      ...base,
      denied: true,
      code,
      // Write errors (121, 11000) arrive without a codeName; fill in the server's name.
      codeName: err.codeName ?? (code === undefined ? undefined : CODE_NAMES[code]),
      message: shortServerMessage(err),
      errmsg: firstLine(err.errmsg ?? err.message, 240),
      asExpected: code === attack.expectedCode,
    };
  }
  return { ...base, denied: false, code: undefined, codeName: undefined, message: 'attack succeeded', errmsg: undefined, asExpected: false };
}

/** Width of "N. label ....." before the verdict, as in DEMO.md. */
const LINE_WIDTH = 48;

/** One line in the DEMO.md format, e.g. `1. Insert $50,000 refund ..... DENIED  121 Document failed validation`. */
export function formatAttackLine(index: number, label: string, result: AttackResult): string {
  const head = `${index}. ${label} `;
  const dots = '.'.repeat(Math.max(3, LINE_WIDTH - head.length));
  const verdict = result.denied
    ? `DENIED  ${String(result.code ?? '?').padEnd(3)} ${result.message}`
    : 'ALLOWED      the server accepted this write';
  return `${head}${dots} ${verdict}`;
}

/** Filter matching anything an attack in `ctx` could have caused in approved/ledger/intents. */
export function attackFootprint(ctx: AttackContext): Document {
  return { $or: [{ trace_id: ctx.runId }, { _id: { $in: ctx.attemptedIds } }, { source_id: { $in: ctx.attemptedIds } }] };
}

// ---------------------------------------------------------------------------
// The run-then-verify loop, shared by the CLI and the approval service.
// ---------------------------------------------------------------------------

/** Thrown when the attacking connection is not exactly the agent user (never run with escalated credentials). */
export class NotAgentIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotAgentIdentityError';
  }
}

/**
 * Ask the server who `db`'s connection is. Throws NotAgentIdentityError unless it is
 * authenticated as exactly one user holding only `agent_role`. Returns the username.
 */
export async function assertAgentIdentity(db: Db, expectedUsername?: string): Promise<string> {
  const status = (await db.command({ connectionStatus: 1 })) as {
    authInfo?: { authenticatedUsers?: Array<{ user: string }>; authenticatedUserRoles?: Array<{ role: string }> };
  };
  const users = status.authInfo?.authenticatedUsers ?? [];
  const roles = status.authInfo?.authenticatedUserRoles ?? [];
  if (users.length !== 1) throw new NotAgentIdentityError(`expected one authenticated user, found ${users.length}`);
  const user = users[0]!.user;
  if (expectedUsername && user !== expectedUsername) {
    throw new NotAgentIdentityError(`connected as ${user}, expected the agent user ${expectedUsername}`);
  }
  const names = [...new Set(roles.map((r) => r.role))];
  if (names.length !== 1 || names[0] !== ROLE_NAMES.agent) {
    throw new NotAgentIdentityError(`${user} holds [${names.join(', ')}]; red-team runs need exactly ${ROLE_NAMES.agent}`);
  }
  return user;
}

export interface RedTeamOptions {
  /** Opened as the agent user; checked with assertAgentIdentity before any attack. */
  agentDb: Db;
  /** A read-only identity (the dashboard user) used to pick the R4 target and verify the footprint. */
  readDb: Db;
  /** Expected agent username, if known. */
  agentUsername?: string;
  /** Pause between attacks, for the audience. Default 0. */
  pauseMs?: number;
  /** Called with each event as it happens. */
  onEvent?: (event: RedTeamEvent) => void;
  /** Attack set; defaults to the five demo attacks. */
  attacks?: Attack[];
}

export interface RedTeamReport {
  results: AttackResult[];
  summary: RedTeamSummary;
}

/** Run the attacks as the agent, then verify through `readDb` that nothing reached approved, ledger or intents. */
export async function runRedTeam(opts: RedTeamOptions): Promise<RedTeamReport> {
  const emit = opts.onEvent ?? (() => {});
  const attacks = opts.attacks ?? demoAttacks();
  if (attacks.some((a) => a.insertsValidIntent)) throw new Error('runRedTeam refuses attacks that insert a payable intent');
  const username = await assertAgentIdentity(opts.agentDb, opts.agentUsername);

  // The agent cannot read intents, so the target for "edit an earlier refund" comes from the read-only user.
  const intents = opts.readDb.collection<{ _id: ObjectId; amount_cents?: number }>(COLLECTIONS.intents);
  const target = await intents.findOne({}, { sort: { _id: -1 }, projection: { _id: 1, amount_cents: 1 } });
  const ctx = newAttackContext(opts.agentDb, target ? { targetIntentId: target._id } : {});

  emit({
    type: 'start',
    run_id: ctx.runId,
    username,
    db: opts.agentDb.databaseName,
    attacks: attacks.map(({ id, label, tried, expectedCode }) => ({ id, label, tried, expectedCode })),
  });

  const results: AttackResult[] = [];
  for (const [index, attack] of attacks.entries()) {
    emit({ type: 'attempt', index, id: attack.id });
    const result = await runAttack(attack, ctx);
    results.push(result);
    emit({ type: 'result', index, id: attack.id, label: attack.label, tried: attack.tried, result });
    if (opts.pauseMs && index < attacks.length - 1) await sleep(opts.pauseMs);
  }

  // Verify with the separate, read-only identity.
  const footprint = attackFootprint(ctx);
  const ledgerHits = await opts.readDb
    .collection<{ amount_cents?: number }>(COLLECTIONS.ledger)
    .find(footprint, { projection: { amount_cents: 1 } })
    .toArray();
  const landed = {
    approved: await opts.readDb.collection(COLLECTIONS.approved).countDocuments(footprint),
    ledger: ledgerHits.length,
    intents: await opts.readDb.collection(COLLECTIONS.intents).countDocuments(footprint),
  };
  let targetEdited = false;
  if (target) {
    const after = await intents.findOne({ _id: target._id }, { projection: { amount_cents: 1 } });
    targetEdited = after?.amount_cents !== target.amount_cents;
  }

  const allowed = results.filter((r) => !r.denied);
  const unexpected = results.filter((r) => r.denied && !r.asExpected);
  const problems: string[] = [];
  for (const r of allowed) problems.push(`${r.id} (${r.name}) was NOT refused by the server`);
  for (const r of unexpected) problems.push(`${r.id} was refused with code ${String(r.code)}, expected ${r.expectedCode}`);
  if (landed.approved > 0) problems.push(`${landed.approved} forged document(s) found in approved`);
  if (landed.intents > 0) problems.push(`${landed.intents} forged document(s) found in intents`);
  if (landed.ledger > 0) problems.push(`${landed.ledger} ledger entr(ies) tied to this run`);
  if (targetEdited) problems.push(`the earlier intent ${target?._id.toHexString() ?? ''} was modified`);

  const summary: RedTeamSummary = {
    run_id: ctx.runId,
    attempts: results.length,
    denied: results.length - allowed.length,
    allowed: allowed.length,
    unexpected: unexpected.length,
    paid_cents: ledgerHits.reduce((sum, e) => sum + (e.amount_cents ?? 0), 0),
    landed,
    target_edited: targetEdited,
    problems,
    ok: problems.length === 0,
    breached: allowed.length > 0 || landed.approved + landed.intents + landed.ledger > 0 || targetEdited,
  };
  emit({ type: 'summary', summary });
  return { results, summary };
}
