/**
 * Fixtures for the executor tests (TEST_PLAN sections 3 and 4). Not a test file.
 * Documents are written as admin but still pass the real validators from applySchema.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS, DEFAULT_POLICY, ledgerSourceId, type ApprovedDoc, type IntentDoc, type OrderDoc } from '@escrowops/shared';
import type { ExecutorLedgerDoc } from '@escrowops/executor';

let seq = 0;
const next = () => `${++seq}-${randomBytes(3).toString('hex')}`;

/** Collections a payout run writes to; cleared between chaos rounds. */
const RUN_DATA = [COLLECTIONS.orders, COLLECTIONS.intents, COLLECTIONS.approved, COLLECTIONS.ledger, COLLECTIONS.executor_state];

export async function clearRunData(db: Db): Promise<void> {
  await Promise.all(RUN_DATA.map((c) => db.collection(c).deleteMany({})));
}

export const ledgerOf = (db: Db) => db.collection<ExecutorLedgerDoc>(COLLECTIONS.ledger);

export async function seedOrder(db: Db, overrides: Partial<OrderDoc> = {}): Promise<OrderDoc> {
  const id = next();
  const order: OrderDoc = {
    _id: `O-${id}`,
    customer_id: 'C-alice',
    items: [{ sku: 'SKU-1', name: 'Test item', quantity: 1, unit_price_cents: 2_000_000 }],
    amount_cents: 2_000_000,
    refunded_cents: 0,
    currency: 'usd',
    payment_id: `pi_fake_${id}`,
    status: 'paid',
    created_at: new Date(),
    ...overrides,
  };
  await db.collection<OrderDoc>(COLLECTIONS.orders).insertOne(order);
  return order;
}

function proposal(order: Pick<OrderDoc, '_id' | 'customer_id'>, amount_cents: number, extra: Partial<IntentDoc>): IntentDoc {
  const ticket_id = extra.ticket_id ?? `T-${next()}`;
  return {
    _id: new ObjectId(),
    trace_id: `trace-${next()}`,
    ticket_id,
    order_id: order._id,
    customer_id: order.customer_id,
    amount_cents,
    currency: 'usd',
    reason: 'Item arrived damaged; photo evidence attached by the customer.',
    evidence: [{ kind: 'order', ref: order._id }],
    policy_version: DEFAULT_POLICY.version,
    idempotency_key: createHash('sha256').update(`${ticket_id}:${order._id}`).digest('hex'),
    created_at: new Date(),
    ...extra,
  };
}

export async function insertIntent(
  db: Db,
  order: Pick<OrderDoc, '_id' | 'customer_id'>,
  amount_cents: number,
  extra: Partial<IntentDoc> = {},
): Promise<IntentDoc> {
  const doc = proposal(order, amount_cents, extra);
  await db.collection<IntentDoc>(COLLECTIONS.intents).insertOne(doc);
  return doc;
}

/** An approved refund with two distinct approvers, so any amount up to the hard cap is valid. */
export async function insertApproved(
  db: Db,
  order: OrderDoc,
  amount_cents: number,
  extra: Partial<IntentDoc> = {},
): Promise<ApprovedDoc> {
  const now = new Date();
  const doc: ApprovedDoc = {
    ...proposal(order, amount_cents, extra),
    review_id: new ObjectId(),
    approvals: [
      { approver_id: 'approver-a', approved_at: now },
      { approver_id: 'approver-b', approved_at: now },
    ],
  };
  await db.collection<ApprovedDoc>(COLLECTIONS.approved).insertOne(doc);
  return doc;
}

/** A ledger entry as a crashed executor would have left it. */
export function abandonedPending(
  source: IntentDoc,
  fields: Pick<ExecutorLedgerDoc, 'checks_passed' | 'attempts'> & Partial<ExecutorLedgerDoc>,
): ExecutorLedgerDoc {
  const past = new Date(Date.now() - 60_000);
  return {
    source_id: ledgerSourceId('intents', source._id),
    source_collection: 'intents',
    source_doc_id: source._id,
    trace_id: source.trace_id,
    ticket_id: source.ticket_id,
    order_id: source.order_id,
    customer_id: source.customer_id,
    amount_cents: source.amount_cents,
    currency: 'usd',
    status: 'pending',
    provider: 'fake',
    owner: 'executor-dead',
    created_at: past,
    updated_at: past,
    ...fields,
  };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  { timeoutMs = 5000, intervalMs = 50, what = 'condition' } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
