/**
 * TEST_PLAN section 1, `budgets` validator: V40 to V43. The executor reserves
 * budget with an atomic `$inc`; the `$expr` validator rejects any post-image
 * where spent_cents > cap_cents.
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, DEFAULT_POLICY, applySchema, type BudgetDoc } from '@escrowops/shared';
import { ERROR_CODES, captureServerError, useTestDb } from '../helpers/index.js';
import { expectRejected } from './fixtures.js';

const t = useTestDb('validators');
const CAP = 10_000;

beforeAll(async () => {
  await applySchema(t().db, DEFAULT_POLICY);
});

const budgets = () => t().db.collection<BudgetDoc>(COLLECTIONS.budgets);

/** A fresh budget document; `_id` is unique per test so tests are independent. */
async function newBudget(spent: number, cap = CAP): Promise<string> {
  const _id = `2026-11-14-${randomBytes(4).toString('hex')}`;
  await budgets().insertOne({ _id, cap_cents: cap, spent_cents: spent });
  return _id;
}

const reserve = (id: string, cents: number) => budgets().updateOne({ _id: id }, { $inc: { spent_cents: cents } });
const spent = async (id: string) => (await budgets().findOne({ _id: id }))?.spent_cents;

describe('budgets validator', () => {
  it('V40 accepts: $inc keeping spent under cap', async () => {
    const id = await newBudget(1_000);
    expect((await reserve(id, 4_000)).modifiedCount).toBe(1);
    expect(await spent(id)).toBe(5_000);
  });

  it('V41 accepts: $inc taking spent exactly to cap', async () => {
    const id = await newBudget(4_000);
    expect((await reserve(id, 6_000)).modifiedCount).toBe(1);
    expect(await spent(id)).toBe(CAP);
  });

  it('V42 rejects: $inc taking spent over cap, stored value unchanged', async () => {
    const id = await newBudget(9_500);
    await expectRejected(() => reserve(id, 501), { rule: '$expr' });
    expect(await spent(id)).toBe(9_500);
    // At the cap, even 1 cent more is refused.
    await reserve(id, 500);
    await expectRejected(() => reserve(id, 1), { rule: '$expr' });
    expect(await spent(id)).toBe(CAP);
  });

  it('B-budget-insert rejects: inserting a budget already over its cap', async () => {
    await expectRejected(
      () => budgets().insertOne({ _id: `over-${randomBytes(4).toString('hex')}`, cap_cents: 100, spent_cents: 101 }),
      { rule: '$expr' },
    );
  });

  it('V43 20 concurrent $inc that together exceed the cap: final spent <= cap, excess rejected', async () => {
    const id = await newBudget(0);
    const STEP = 700;
    const N = 20;
    const results = await Promise.allSettled(Array.from({ length: N }, () => reserve(id, STEP)));

    const accepted = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    for (const r of rejected) {
      const err = await captureServerError(() => Promise.reject(r.reason));
      expect(err.code).toBe(ERROR_CODES.DOCUMENT_VALIDATION_FAILURE);
    }

    const final = await spent(id);
    expect(final).toBeLessThanOrEqual(CAP);
    expect(final).toBe(accepted.length * STEP);
    expect(accepted.length).toBe(Math.floor(CAP / STEP)); // 14
    expect(rejected.length).toBe(N - Math.floor(CAP / STEP)); // 6
  });
});
