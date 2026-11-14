/** E6 / TEST_PLAN I15: the daily auto-refund budget, enforced by the budgets validator. */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectId } from 'mongodb';
import { COLLECTIONS, ledgerSourceId, type BudgetDoc, type ReviewQueueDoc } from '@escrowops/shared';
import { Executor, FakeProvider } from '@escrowops/executor';
import { ReviewService } from '@escrowops/api';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { abandonedPending, clearRunData, insertApproved, insertIntent, ledgerOf, seedOrder, waitFor } from './fixtures.js';

const t = useTestDb('budget');
const CAP = 10_000; // $100 a day
let provider: FakeProvider;
let executor: Executor | undefined;

const today = () => new Date().toISOString().slice(0, 10);
const budget = () => t().db.collection<BudgetDoc & { reservations?: string[] }>(COLLECTIONS.budgets).findOne({ _id: today() });
const settled = (id: ObjectId) =>
  waitFor(async () => {
    const e = await ledgerOf(t().db).findOne({ source_doc_id: id });
    return e && e.status !== 'pending' ? e : undefined;
  }, { what: `ledger for ${id}` });

async function startExecutor(dailyBudgetCents = CAP) {
  executor = new Executor({
    db: (await t().connectAsRole('executor')).db(t().dbName),
    provider,
    log: () => {},
    staleReconcileEveryMs: 0,
    dailyBudgetCents,
  });
  await executor.start();
}

beforeAll(async () => {
  await setUpAccess(t());
});
beforeEach(async () => {
  await clearRunData(t().db);
  await t().db.collection(COLLECTIONS.budgets).deleteMany({});
  await t().db.collection(COLLECTIONS.review_queue).deleteMany({});
  provider = new FakeProvider();
});
afterEach(async () => {
  await executor?.stop();
  executor = undefined;
});

describe('daily auto-refund budget (E6)', () => {
  it('reserves each auto refund against the day', async () => {
    const order = await seedOrder(t().db);
    await startExecutor();
    const a = await insertIntent(t().db, order, 4_000);
    expect((await settled(a._id)).status).toBe('succeeded');
    expect(await budget()).toMatchObject({ cap_cents: CAP, spent_cents: 4_000, reservations: [ledgerSourceId('intents', a._id)] });
  });

  it('I15: once the budget is spent, the next auto refund is diverted to review, not paid', async () => {
    const order = await seedOrder(t().db);
    await startExecutor();
    const a = await insertIntent(t().db, order, 7_000);
    expect((await settled(a._id)).status).toBe('succeeded');

    const b = await insertIntent(t().db, order, 4_000); // 7,000 + 4,000 > 10,000
    const entry = await settled(b._id);
    expect(entry).toMatchObject({ status: 'failed', failure_reason: expect.stringMatching(/^budget_exhausted/) });
    expect(provider.calls).toHaveLength(1);
    expect((await budget())?.spent_cents).toBe(7_000);

    const review = await t().db.collection<ReviewQueueDoc>(COLLECTIONS.review_queue).findOne({ ticket_id: b.ticket_id });
    expect(review).toMatchObject({ status: 'pending', required_approvals: 1, amount_cents: 4_000, idempotency_key: b.idempotency_key });
    expect(review?.validator_error?.code).toBe(121);
  });

  it('a diverted refund is paid once a human approves it, outside the budget', async () => {
    const order = await seedOrder(t().db);
    await startExecutor(3_000);
    const intent = await insertIntent(t().db, order, 4_000); // over the whole day's budget
    expect((await settled(intent._id)).failure_reason).toMatch(/^budget_exhausted/);

    const approverClient = await t().connectAsRole('approver');
    const reviews = new ReviewService(approverClient, approverClient.db(t().dbName));
    const review = await t().db.collection<ReviewQueueDoc>(COLLECTIONS.review_queue).findOne({ ticket_id: intent.ticket_id });
    expect((await reviews.approve(review!._id, 'approver-a')).outcome).toBe('promoted');

    const paid = await waitFor(() => ledgerOf(t().db).findOne({ ticket_id: intent.ticket_id, status: 'succeeded' }), { what: 'approved payout' });
    expect(paid.source_collection).toBe('approved');
    expect(provider.created).toHaveLength(1);
    expect((await budget())?.spent_cents ?? 0).toBe(0);
  });

  it('human-approved refunds do not count against the budget', async () => {
    const order = await seedOrder(t().db);
    await startExecutor();
    const doc = await insertApproved(t().db, order, 60_000);
    expect((await settled(doc._id)).status).toBe('succeeded');
    expect(await budget()).toBeNull();
  });

  it('a retried reservation for the same source is counted once', async () => {
    const order = await seedOrder(t().db);
    const intent = await insertIntent(t().db, order, 2_500);
    const sid = ledgerSourceId('intents', intent._id);
    // A crash after reserving but before recording checks_passed.
    await t().db.collection(COLLECTIONS.budgets).insertOne({ _id: today(), cap_cents: CAP, spent_cents: 2_500, reservations: [sid] } as never);
    await ledgerOf(t().db).insertOne(abandonedPending(intent, { checks_passed: false, attempts: 0 }));

    await startExecutor();
    expect((await settled(intent._id)).status).toBe('succeeded');
    expect((await budget())?.spent_cents).toBe(2_500);
  });

  it('is off when the cap is 0', async () => {
    const order = await seedOrder(t().db);
    await startExecutor(0);
    const a = await insertIntent(t().db, order, 40_000);
    expect((await settled(a._id)).status).toBe('succeeded');
    expect(await budget()).toBeNull();
  });
});
