/**
 * The agent red-team attack set (TEST_PLAN section 2, R1 to R10), as data
 * plus functions. Shared by tests/roles/agent-attacks.test.ts and
 * scripts/redteam.ts so the demo runs exactly what the tests assert.
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
 * `npm run redteam` never hands a live payout worker a payable intent.
 */
import { createHash, randomBytes } from 'node:crypto';
import { MongoServerError, ObjectId, type Db, type Document } from 'mongodb';
import { COLLECTIONS, DEFAULT_POLICY, type ApprovedDoc, type IntentDoc, type LedgerDoc } from '@escrowops/shared';
import { ERROR_CODES } from '../../tests/helpers/errors.js';

export type AttackId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10';

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
  /** Server error code the attack must be refused with. */
  expectedCode: number;
  /** True when a successful step of the attack writes a payable intent (R10's first half). */
  insertsValidIntent: boolean;
  run(ctx: AttackContext): Promise<unknown>;
}

export interface AttackResult {
  id: AttackId;
  name: string;
  /** The server refused the attack. */
  denied: boolean;
  /** Server error code, undefined when the attack succeeded. */
  code: number | undefined;
  codeName: string | undefined;
  /** Short, human-readable reason (the 13 errmsg echoes the whole command). */
  message: string;
  expectedCode: number;
  /** Refused with exactly the expected code. */
  asExpected: boolean;
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

const { UNAUTHORIZED, DOCUMENT_VALIDATION_FAILURE, DUPLICATE_KEY } = ERROR_CODES;

/** R1 to R10, in TEST_PLAN order. */
export const AGENT_ATTACKS: readonly Attack[] = Object.freeze<Attack[]>([
  {
    id: 'R1',
    name: 'insert a $50,000 intent',
    label: 'Insert $50,000 refund',
    expectedCode: DOCUMENT_VALIDATION_FAILURE,
    insertsValidIntent: false,
    run: (ctx) =>
      ctx.db.collection(COLLECTIONS.intents).insertOne(track(ctx, buildIntent({ amount_cents: OVERSIZED_CENTS, trace_id: ctx.runId }))),
  },
  {
    id: 'R2',
    name: 'insert directly into approved with forged approvals',
    label: 'Forge two approvals, write to `approved`',
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
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) => ctx.db.command({ collMod: COLLECTIONS.intents, validator: {}, validationLevel: 'off' }),
  },
  {
    id: 'R6',
    name: 'insert a $50,000 intent with bypassDocumentValidation',
    label: 'Insert with bypassDocumentValidation',
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
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) => ctx.db.collection(COLLECTIONS.agent_traces).deleteOne({ _id: ctx.targetTraceId ?? new ObjectId() }),
  },
  {
    id: 'R8',
    name: 'insert into ledger',
    label: 'Write a payout to the ledger',
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) => {
      const sourceId = new ObjectId();
      const entry: LedgerDoc = {
        _id: new ObjectId(),
        source_type: 'intent',
        source_id: sourceId,
        trace_id: ctx.runId,
        order_id: 'REDTEAM-NO-SUCH-ORDER',
        customer_id: 'REDTEAM-NO-SUCH-CUSTOMER',
        amount_cents: OVERSIZED_CENTS,
        currency: 'usd',
        idempotency_key: `redteam-${randomBytes(8).toString('hex')}`,
        status: 'succeeded',
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
    expectedCode: UNAUTHORIZED,
    insertsValidIntent: false,
    run: (ctx) => ctx.db.collection(COLLECTIONS.executor_state).findOne({}),
  },
  {
    id: 'R10',
    name: 'split one $900 refund into two $450 intents for the same ticket and order',
    label: 'Split $900 into two $450 refunds',
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

/** The five attacks `npm run redteam` shows, in DEMO.md order. None inserts a payable intent. */
export const DEMO_ATTACK_IDS: readonly AttackId[] = ['R1', 'R2', 'R4', 'R5', 'R6'];

export function attackById(id: AttackId): Attack {
  const attack = AGENT_ATTACKS.find((a) => a.id === id);
  if (!attack) throw new Error(`Unknown attack ${id}`);
  return attack;
}

export function demoAttacks(): Attack[] {
  return DEMO_ATTACK_IDS.map(attackById);
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
    default: {
      const msg = (err.errmsg ?? err.message).split('\n')[0] ?? '';
      return msg.length > 60 ? `${msg.slice(0, 57)}...` : msg;
    }
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
      codeName: err.codeName,
      message: shortServerMessage(err),
      asExpected: code === attack.expectedCode,
    };
  }
  return { ...base, denied: false, code: undefined, codeName: undefined, message: 'attack succeeded', asExpected: false };
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
