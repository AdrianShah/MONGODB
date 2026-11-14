/**
 * TEST_PLAN section 3 (executor side): I1, I11 to I14, plus E3 and E4.
 * The executor runs in-process as escrow_executor with FakeProvider.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectId } from 'mongodb';
import { COLLECTIONS } from '@escrowops/shared';
import { Executor, FakeProvider, type ExecutorOptions } from '@escrowops/executor';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import {
  abandonedPending,
  clearRunData,
  insertApproved,
  insertIntent,
  ledgerOf,
  seedOrder,
  waitFor,
} from './fixtures.js';

const t = useTestDb('executor');
let provider: FakeProvider;
let executor: Executor | undefined;

const ledger = () => ledgerOf(t().db);
const settled = (sourceId: ObjectId) =>
  waitFor(
    async () => {
      const e = await ledger().findOne({ source_id: sourceId });
      return e && e.status !== 'pending' ? e : undefined;
    },
    { what: `ledger entry for ${sourceId} to settle` },
  );

async function startExecutor(opts: Partial<ExecutorOptions> = {}) {
  const client = await t().connectAsRole('executor');
  executor = new Executor({
    db: client.db(t().dbName),
    provider,
    log: () => {},
    retryBaseMs: 10,
    staleReconcileEveryMs: 0,
    ...opts,
  });
  await executor.start();
  return executor;
}

beforeAll(async () => {
  await setUpAccess(t());
});
beforeEach(async () => {
  await clearRunData(t().db);
  provider = new FakeProvider();
});
afterEach(async () => {
  await executor?.stop();
  executor = undefined;
});

describe('payout', () => {
  it('I1: pays an auto-approved intent once, through the stream, within 2 s', async () => {
    const order = await seedOrder(t().db);
    await startExecutor();
    const started = Date.now();
    const intent = await insertIntent(t().db, order, 4200);

    const entry = await settled(intent._id);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(entry).toMatchObject({ status: 'succeeded', source_type: 'intent', provider: 'fake' });
    expect(entry.provider_refund_id).toMatch(/^re_fake_/);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.request).toMatchObject({
      paymentRef: order.payment_id,
      amountCents: 4200,
      idempotencyKey: intent.idempotency_key,
    });
  });

  it('pays a document inserted into approved', async () => {
    const order = await seedOrder(t().db);
    await startExecutor();
    const doc = await insertApproved(t().db, order, 500_000);
    expect(await settled(doc._id)).toMatchObject({ status: 'succeeded', source_type: 'approved' });
    expect(provider.created).toHaveLength(1);
  });

  it('saves a resume token after each stream event', async () => {
    const order = await seedOrder(t().db);
    await startExecutor();
    await settled((await insertIntent(t().db, order, 1000))._id);
    await executor!.idle();
    const state = await t().db.collection<{ _id: string }>(COLLECTIONS.executor_state).findOne({ _id: 'stream:intents' });
    expect(state?.['resume_token' as never]).toBeTruthy();
  });
});

describe('pre-payout checks (E5)', () => {
  it("I11: refuses a refund larger than the order's remaining refundable amount", async () => {
    const order = await seedOrder(t().db, { amount_cents: 30_000 });
    await startExecutor();
    expect((await settled((await insertIntent(t().db, order, 20_000))._id)).status).toBe('succeeded');

    const entry = await settled((await insertIntent(t().db, order, 20_000))._id);
    expect(entry.status).toBe('failed');
    expect(entry.failure_reason).toMatch(/^exceeds_refundable/);
    expect(provider.calls).toHaveLength(1);
  });

  it('counts refunds already on the order (refunded_cents)', async () => {
    const order = await seedOrder(t().db, { amount_cents: 10_000, refunded_cents: 9_000 });
    await startExecutor();
    expect((await settled((await insertIntent(t().db, order, 2_000))._id)).failure_reason).toMatch(/^exceeds_refundable/);
    expect(provider.calls).toHaveLength(0);
  });

  it('I12: refuses when the order belongs to a different customer', async () => {
    const order = await seedOrder(t().db, { customer_id: 'C-bob' });
    await startExecutor();
    const entry = await settled((await insertIntent(t().db, order, 1000, { customer_id: 'C-alice' }))._id);
    expect(entry.status).toBe('failed');
    expect(entry.failure_reason).toMatch(/^order_customer_mismatch/);
    expect(provider.calls).toHaveLength(0);
  });

  it('refuses when the order does not exist', async () => {
    await startExecutor();
    const intent = await insertIntent(t().db, { _id: 'O-missing', customer_id: 'C-alice' }, 1000);
    expect((await settled(intent._id)).failure_reason).toMatch(/^order_not_found/);
  });
});

describe('provider errors', () => {
  it('I13: retries a transient error with the same key and pays once', async () => {
    const order = await seedOrder(t().db);
    provider.failTransiently(2);
    await startExecutor();
    const entry = await settled((await insertIntent(t().db, order, 1500))._id);
    expect(entry.status).toBe('succeeded');
    expect(entry.attempts).toBe(3);
    expect(new Set(provider.calls.map((c) => c.request.idempotencyKey)).size).toBe(1);
    expect(provider.created).toHaveLength(1);
  });

  it('leaves the entry pending when transient errors outlast the retries', async () => {
    const order = await seedOrder(t().db);
    provider.failTransiently(100);
    await startExecutor({ maxTransientAttempts: 2 });
    const intent = await insertIntent(t().db, order, 1500);
    await waitFor(async () => provider.calls.length >= 2, { what: 'two attempts' });
    await executor!.idle();
    expect((await ledger().findOne({ source_id: intent._id }))?.status).toBe('pending');
  });

  it('I14: records a permanent error as failed and does not retry', async () => {
    const order = await seedOrder(t().db);
    provider.failPermanently('charge_already_refunded');
    await startExecutor();
    const entry = await settled((await insertIntent(t().db, order, 1500))._id);
    expect(entry.status).toBe('failed');
    expect(entry.failure_reason).toMatch(/charge_already_refunded/);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('recovery', () => {
  it('E4: the startup sweep pays sources that have no ledger entry', async () => {
    const order = await seedOrder(t().db);
    const a = await insertIntent(t().db, order, 1000);
    const b = await insertApproved(t().db, order, 60_000);
    await startExecutor();
    expect((await settled(a._id)).status).toBe('succeeded');
    expect((await settled(b._id)).status).toBe('succeeded');
    expect(provider.created).toHaveLength(2);
  });

  it('does not pay twice when the same source is seen again after a restart', async () => {
    const order = await seedOrder(t().db);
    await startExecutor();
    await settled((await insertIntent(t().db, order, 1000))._id);
    await executor!.stop();

    // Throw away the resume token so the sweep sees the paid intent again.
    await t().db.collection(COLLECTIONS.executor_state).deleteMany({});
    await startExecutor();
    await executor!.idle();
    expect(provider.calls).toHaveLength(1);
    expect(await ledger().countDocuments()).toBe(1);
  });

  it('E3: a pending entry that passed its checks is retried with the same key, not re-paid', async () => {
    const order = await seedOrder(t().db);
    const intent = await insertIntent(t().db, order, 2500);
    // A crash after the provider call but before the ledger update.
    const paid = await provider.refund({
      paymentRef: order.payment_id,
      amountCents: 2500,
      currency: 'usd',
      idempotencyKey: intent.idempotency_key,
    });
    await ledger().insertOne(abandonedPending(intent, { checks_passed: true, attempts: 1 }));

    await startExecutor();
    const entry = await settled(intent._id);
    expect(entry.status).toBe('succeeded');
    expect(entry.provider_refund_id).toBe(paid.refundId);
    expect(provider.created).toHaveLength(1);
    expect(provider.calls.map((c) => c.outcome)).toEqual(['created', 'replayed']);
  });

  it('E3: a pending entry that never passed its checks is re-checked on reconcile', async () => {
    const order = await seedOrder(t().db, { customer_id: 'C-bob' });
    const intent = await insertIntent(t().db, order, 2500, { customer_id: 'C-alice' });
    await ledger().insertOne(abandonedPending(intent, { checks_passed: false, attempts: 0 }));
    await startExecutor();
    expect((await settled(intent._id)).failure_reason).toMatch(/^order_customer_mismatch/);
    expect(provider.calls).toHaveLength(0);
  });

  it('an abandoned pending entry is picked up by the periodic reconcile', async () => {
    const order = await seedOrder(t().db);
    provider.failTransiently(100);
    await startExecutor({ maxTransientAttempts: 1, staleReconcileEveryMs: 100, staleAfterMs: 200 });
    const intent = await insertIntent(t().db, order, 1500);
    await waitFor(async () => provider.calls.length >= 1, { what: 'first attempt' });
    provider.failTransiently(0);
    expect((await settled(intent._id)).status).toBe('succeeded');
    expect(provider.created).toHaveLength(1);
  });
});
