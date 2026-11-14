/**
 * TEST_PLAN section 1, `approved` validator: V20 to V29, plus boundaries.
 * The validator is `$and: [$jsonSchema, distinct $expr, second-approver $or]`,
 * so every rejection is asserted with the clause index that failed.
 */
import { ObjectId, type Document } from 'mongodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, DEFAULT_POLICY, applySchema } from '@escrowops/shared';
import { useTestDb } from '../helpers/index.js';
import { APPROVED_CLAUSE, approvedDoc, expectRejected, without, type ExpectedRule } from './fixtures.js';

const t = useTestDb('validators');
const P = DEFAULT_POLICY;

beforeAll(async () => {
  await applySchema(t().db, P);
});

const insert = (doc: Document) => t().db.collection(COLLECTIONS.approved).insertOne(doc);

const ONE = ['alice'];
const TWO = ['alice', 'bob'];
const THREE = ['alice', 'bob', 'carol'];

const accepts: Array<{ id: string; title: string; doc: () => Document }> = [
  { id: 'V20', title: '$1,500, one approver', doc: () => approvedDoc(150_000, ONE) },
  { id: 'V21', title: '$5,000, two distinct approvers', doc: () => approvedDoc(500_000, TWO) },
  { id: 'V25', title: '$10,000.00 (1000000), two approvers', doc: () => approvedDoc(P.hard_cap_cents, TWO) },
  { id: 'V28', title: '$2,000.00 (200000), one approver (boundary)', doc: () => approvedDoc(P.single_approver_cap_cents, ONE) },
  { id: 'B-approved-small', title: 'boundary: $500.00 at the auto cap, one approver', doc: () => approvedDoc(P.auto_cap_cents, ONE) },
  { id: 'B-approved-three', title: 'boundary: $5,000, three distinct approvers', doc: () => approvedDoc(500_000, THREE) },
];

const S = APPROVED_CLAUSE;
const rejects: Array<{ id: string; title: string; doc: () => Document; expect: ExpectedRule }> = [
  { id: 'V22', title: '$5,000, one approver', doc: () => approvedDoc(500_000, ONE), expect: { rule: '$or', clause: S.secondApprover } },
  { id: 'V23', title: '$5,000, same approver twice', doc: () => approvedDoc(500_000, ['alice', 'alice']), expect: { rule: '$expr', clause: S.distinct } },
  { id: 'V23', title: '$1,500, same approver twice', doc: () => approvedDoc(150_000, ['alice', 'alice']), expect: { rule: '$expr', clause: S.distinct } },
  { id: 'V24', title: '$1,500, zero approvers', doc: () => approvedDoc(150_000, []), expect: { rule: 'minItems', property: 'approvals', clause: S.schema } },
  { id: 'V26', title: '$10,000.01, two approvers', doc: () => approvedDoc(P.hard_cap_cents + 1, TWO), expect: { rule: 'maximum', property: 'amount_cents', clause: S.schema } },
  { id: 'V27', title: '$10,000.01, three approvers', doc: () => approvedDoc(P.hard_cap_cents + 1, THREE), expect: { rule: 'maximum', property: 'amount_cents', clause: S.schema } },
  { id: 'V29', title: '$2,000.01 (200001), one approver', doc: () => approvedDoc(P.single_approver_cap_cents + 1, ONE), expect: { rule: '$or', clause: S.secondApprover } },
  { id: 'B-approved-missing-review', title: 'boundary: missing review_id', doc: () => without(approvedDoc(150_000, ONE), 'review_id'), expect: { rule: 'required', clause: S.schema } },
  { id: 'B-approved-missing-approvals', title: 'boundary: missing approvals', doc: () => without(approvedDoc(150_000, ONE), 'approvals'), expect: { rule: 'required', clause: S.schema } },
  { id: 'B-approved-extra', title: 'boundary: extra field', doc: () => approvedDoc(150_000, ONE, { bypass: true }), expect: { rule: 'additionalProperties', clause: S.schema } },
  { id: 'B-approved-entry', title: 'boundary: approval entry without approver_id', doc: () => approvedDoc(150_000, [], { approvals: [{ approved_at: new Date() }] }), expect: { rule: 'required', property: 'approvals', clause: S.schema } },
  { id: 'B-approved-version', title: 'boundary: stale policy_version', doc: () => approvedDoc(150_000, ONE, { policy_version: P.version - 1 }), expect: { rule: 'enum', property: 'policy_version', clause: S.schema } },
  { id: 'B-approved-review-type', title: 'boundary: review_id as string', doc: () => approvedDoc(150_000, ONE, { review_id: new ObjectId().toHexString() }), expect: { rule: 'bsonType', property: 'review_id', clause: S.schema } },
];

describe('approved validator', () => {
  it.each(accepts)('$id accepts: $title', async ({ doc }) => {
    const d = doc();
    expect((await insert(d)).insertedId).toEqual(d['_id']);
  });

  it.each(rejects)('$id rejects: $title', async (row) => {
    const d = row.doc();
    await expectRejected(() => insert(d), row.expect);
    expect(await t().db.collection(COLLECTIONS.approved).countDocuments({ _id: d['_id'] })).toBe(0);
  });
});
