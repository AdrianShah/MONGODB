/**
 * TEST_PLAN section 1, `intents` validator: V1 to V13, plus boundaries.
 * Each row inserts one document as admin.
 */
import { BSON, type Document } from 'mongodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, DEFAULT_POLICY, applySchema } from '@escrowops/shared';
import { useTestDb } from '../helpers/index.js';
import { expectRejected, findOperatorNodes, validIntent, without, type ExpectedRule } from './fixtures.js';

const t = useTestDb('validators');
const P = DEFAULT_POLICY;

beforeAll(async () => {
  await applySchema(t().db, P);
});

const insert = (doc: Document) => t().db.collection(COLLECTIONS.intents).insertOne(doc);

interface AcceptRow {
  id: string;
  title: string;
  doc: () => Document;
}

interface RejectRow extends AcceptRow {
  expect: ExpectedRule;
  /** Extra assertions on errInfo.details. */
  check?: (details: Document) => void;
}

const accepts: AcceptRow[] = [
  { id: 'V1', title: 'valid, $42.00', doc: () => validIntent({ amount_cents: 4_200 }) },
  { id: 'V2', title: 'exactly the auto cap, $500.00 (50000)', doc: () => validIntent({ amount_cents: P.auto_cap_cents }) },
  { id: 'B-intent-min', title: 'boundary: 1 cent (minimum)', doc: () => validIntent({ amount_cents: 1 }) },
  { id: 'B-intent-long', title: 'boundary: amount as long at the cap', doc: () => validIntent({ amount_cents: BSON.Long.fromNumber(P.auto_cap_cents) }) },
  { id: 'B-reason-min', title: 'boundary: reason exactly 20 characters', doc: () => validIntent({ reason: 'x'.repeat(20) }) },
  { id: 'B-reason-max', title: 'boundary: reason exactly 2000 characters', doc: () => validIntent({ reason: 'x'.repeat(2000) }) },
];

const rejects: RejectRow[] = [
  { id: 'V3', title: '$500.01 (50001)', doc: () => validIntent({ amount_cents: P.auto_cap_cents + 1 }), expect: { rule: 'maximum', property: 'amount_cents' } },
  { id: 'V4', title: '$0', doc: () => validIntent({ amount_cents: 0 }), expect: { rule: 'minimum', property: 'amount_cents' } },
  { id: 'V4', title: 'negative (-100)', doc: () => validIntent({ amount_cents: -100 }), expect: { rule: 'minimum', property: 'amount_cents' } },
  { id: 'V5', title: 'amount_cents as string "100"', doc: () => validIntent({ amount_cents: '100' }), expect: { rule: 'bsonType', property: 'amount_cents' } },
  { id: 'V6', title: 'amount_cents as double 100.5', doc: () => validIntent({ amount_cents: 100.5 }), expect: { rule: 'bsonType', property: 'amount_cents' } },
  { id: 'V6', title: 'amount_cents as integral double 100.0', doc: () => validIntent({ amount_cents: new BSON.Double(100) }), expect: { rule: 'bsonType', property: 'amount_cents' } },
  {
    id: 'V7',
    title: 'missing trace_id',
    doc: () => without(validIntent(), 'trace_id'),
    expect: { rule: 'required' },
    check: (d) => expect(findOperatorNodes(d, 'required')[0]?.['missingProperties']).toEqual(['trace_id']),
  },
  {
    id: 'V8',
    title: 'extra field approvals: [...]',
    doc: () => validIntent({ approvals: [{ approver_id: 'u-1', approved_at: new Date() }] }),
    expect: { rule: 'additionalProperties' },
    check: (d) => expect(findOperatorNodes(d, 'additionalProperties')[0]?.['additionalProperties']).toEqual(['approvals']),
  },
  {
    id: 'V9',
    title: 'extra field tier: "human_required"',
    doc: () => validIntent({ tier: 'human_required' }),
    expect: { rule: 'additionalProperties' },
    check: (d) => expect(findOperatorNodes(d, 'additionalProperties')[0]?.['additionalProperties']).toEqual(['tier']),
  },
  { id: 'V10', title: 'reason under 20 characters (19)', doc: () => validIntent({ reason: 'x'.repeat(19) }), expect: { rule: 'minLength', property: 'reason' } },
  { id: 'V11', title: 'empty evidence', doc: () => validIntent({ evidence: [] }), expect: { rule: 'minItems', property: 'evidence' } },
  { id: 'V12', title: 'currency "eur"', doc: () => validIntent({ currency: 'eur' }), expect: { rule: 'enum', property: 'currency' } },
  { id: 'V13', title: 'stale policy_version', doc: () => validIntent({ policy_version: P.version - 1 }), expect: { rule: 'enum', property: 'policy_version' } },
  { id: 'V13', title: 'future policy_version', doc: () => validIntent({ policy_version: P.version + 1 }), expect: { rule: 'enum', property: 'policy_version' } },
  { id: 'B-reason-long', title: 'boundary: reason 2001 characters', doc: () => validIntent({ reason: 'x'.repeat(2001) }), expect: { rule: 'maxLength', property: 'reason' } },
  { id: 'B-intent-id', title: 'boundary: string _id', doc: () => validIntent({ _id: 'not-an-objectid' }), expect: { rule: 'bsonType', property: '_id' } },
  { id: 'B-evidence-item', title: 'boundary: evidence item not an object', doc: () => validIntent({ evidence: ['photo'] }), expect: { rule: 'items', property: 'evidence' } },
  { id: 'B-created-at', title: 'boundary: created_at as string', doc: () => validIntent({ created_at: new Date().toISOString() }), expect: { rule: 'bsonType', property: 'created_at' } },
];

describe('intents validator', () => {
  it.each(accepts)('$id accepts: $title', async ({ doc }) => {
    const d = doc();
    const res = await insert(d);
    expect(res.insertedId).toEqual(d['_id']);
  });

  it.each(rejects)('$id rejects: $title', async (row) => {
    const d = row.doc();
    const err = await expectRejected(() => insert(d), row.expect);
    row.check?.((err.errInfo as Document)['details'] as Document);
    expect(await t().db.collection(COLLECTIONS.intents).countDocuments({ _id: d['_id'] })).toBe(0);
  });
});
