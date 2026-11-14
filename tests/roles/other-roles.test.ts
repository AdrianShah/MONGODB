/**
 * TEST_PLAN section 2, other roles: R20 to R25. Each case connects as the
 * real role user and expects authorization error 13.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { ALL_COLLECTIONS, COLLECTIONS, type AppRole } from '@escrowops/shared';
import { ERROR_CODES, expectServerError, useTestDb } from '../helpers/index.js';
import { buildApproved, buildIntent } from '../../scripts/lib/redteam-attacks.js';
import { setUpAccess } from './role-helpers.js';

const t = useTestDb('roles_other');
const { UNAUTHORIZED } = ERROR_CODES;

const handles = {} as Record<AppRole, Db>;
let approvalId: ObjectId;
let approvedId: ObjectId;

beforeAll(async () => {
  await setUpAccess(t());
  for (const role of ['approver', 'executor', 'dashboard'] as const) {
    handles[role] = (await t().connectAsRole(role)).db(t().dbName);
  }
  // Real documents to target, written as admin.
  approvalId = (
    await t().db.collection(COLLECTIONS.approvals).insertOne({
      review_id: new ObjectId(),
      approver_id: 'approver-a',
      decision: 'approve',
      created_at: new Date(),
    })
  ).insertedId;
  const approved = buildApproved({ amount_cents: 150_000, trace_id: 'trace-r21', approver_ids: ['approver-a'] });
  await t().db.collection(COLLECTIONS.approved).insertOne(approved);
  approvedId = approved._id;
});

describe('approver (escrow_approver)', () => {
  it('R20: update a document in approvals is refused with 13', async () => {
    await expectServerError(
      () => handles.approver.collection(COLLECTIONS.approvals).updateOne({ _id: approvalId }, { $set: { decision: 'reject' } }),
      UNAUTHORIZED,
    );
  });

  it('R20: delete a document in approvals is refused with 13', async () => {
    await expectServerError(() => handles.approver.collection(COLLECTIONS.approvals).deleteOne({ _id: approvalId }), UNAUTHORIZED);
    expect(await t().db.collection(COLLECTIONS.approvals).countDocuments({ _id: approvalId, decision: 'approve' })).toBe(1);
  });

  it('R21: update a document in approved is refused with 13', async () => {
    await expectServerError(
      () => handles.approver.collection(COLLECTIONS.approved).updateOne({ _id: approvedId }, { $set: { amount_cents: 999_999 } }),
      UNAUTHORIZED,
    );
  });

  it('R21: delete a document in approved is refused with 13', async () => {
    await expectServerError(() => handles.approver.collection(COLLECTIONS.approved).deleteOne({ _id: approvedId }), UNAUTHORIZED);
    expect((await t().db.collection(COLLECTIONS.approved).findOne({ _id: approvedId }))?.['amount_cents']).toBe(150_000);
  });

  it('R22: insert into intents is refused with 13', async () => {
    await expectServerError(
      () => handles.approver.collection(COLLECTIONS.intents).insertOne(buildIntent({ amount_cents: 4_200, trace_id: 'trace-r22' })),
      UNAUTHORIZED,
    );
  });

  it('R22: insert into ledger is refused with 13', async () => {
    await expectServerError(
      () => handles.approver.collection(COLLECTIONS.ledger).insertOne({ source_id: new ObjectId(), status: 'succeeded' }),
      UNAUTHORIZED,
    );
  });
});

describe('executor (escrow_executor)', () => {
  it('R23: insert into intents is refused with 13', async () => {
    await expectServerError(
      () => handles.executor.collection(COLLECTIONS.intents).insertOne(buildIntent({ amount_cents: 4_200, trace_id: 'trace-r23' })),
      UNAUTHORIZED,
    );
  });

  it('R23: insert into approved is refused with 13', async () => {
    await expectServerError(
      () =>
        handles.executor
          .collection(COLLECTIONS.approved)
          .insertOne(buildApproved({ amount_cents: 150_000, trace_id: 'trace-r23', approver_ids: ['approver-a'] })),
      UNAUTHORIZED,
    );
  });

  it('R24: collMod on budgets is refused with 13', async () => {
    await expectServerError(
      () => handles.executor.command({ collMod: COLLECTIONS.budgets, validator: {}, validationLevel: 'off' }),
      UNAUTHORIZED,
    );
  });
});

describe('dashboard (escrow_dashboard)', () => {
  for (const name of ALL_COLLECTIONS) {
    it(`R25: insert, update and delete on ${name} are refused with 13`, async () => {
      const coll = handles.dashboard.collection(name);
      await expectServerError(() => coll.insertOne({ _id: new ObjectId(), probe: true }), UNAUTHORIZED);
      await expectServerError(() => coll.updateMany({}, { $set: { probe: true } }), UNAUTHORIZED);
      await expectServerError(() => coll.deleteMany({}), UNAUTHORIZED);
    });
  }

  it('R25: collMod, createIndex and drop are refused with 13', async () => {
    await expectServerError(() => handles.dashboard.command({ collMod: COLLECTIONS.intents, validator: {} }), UNAUTHORIZED);
    await expectServerError(() => handles.dashboard.collection(COLLECTIONS.intents).createIndex({ probe: 1 }), UNAUTHORIZED);
    await expectServerError(() => handles.dashboard.collection(COLLECTIONS.ledger).drop(), UNAUTHORIZED);
  });
});
