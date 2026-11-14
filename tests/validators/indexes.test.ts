/**
 * TEST_PLAN section 1, unique indexes: V50 to V53, plus review_queue (the
 * fifth index in PRD section 7). The first insert must succeed and the
 * second must fail with E11000.
 */
import { ObjectId, type Document } from 'mongodb';
import { beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, DEFAULT_POLICY, INDEXES, applySchema, type CollectionName } from '@escrowops/shared';
import { ERROR_CODES, expectServerError, useTestDb } from '../helpers/index.js';
import { approvedDoc, validIntent } from './fixtures.js';

const t = useTestDb('validators');

beforeAll(async () => {
  await applySchema(t().db, DEFAULT_POLICY);
});

function reviewQueueDoc(key: string): Document {
  return {
    ...validIntent({ idempotency_key: key, amount_cents: 150_000 }),
    tier: 'peer_review',
    required_approvals: 1,
    status: 'pending',
    validator_error: { code: 121 },
  };
}

function ledgerDoc(sourceId: ObjectId): Document {
  const now = new Date();
  return {
    _id: new ObjectId(),
    source_type: 'intent',
    source_id: sourceId,
    trace_id: 'trace-1',
    order_id: 'O-2001',
    customer_id: 'C-3001',
    amount_cents: 4_200,
    currency: 'usd',
    idempotency_key: `ledger-${new ObjectId().toHexString()}`,
    status: 'pending',
    provider: 'fake',
    created_at: now,
    updated_at: now,
  };
}

const rows: Array<{ id: string; title: string; collection: CollectionName; pair: () => [Document, Document] }> = [
  {
    id: 'V50',
    title: 'two intents with the same idempotency_key',
    collection: COLLECTIONS.intents,
    pair: () => [validIntent({ idempotency_key: 'dup-intent' }), validIntent({ idempotency_key: 'dup-intent' })],
  },
  {
    id: 'V50-review_queue',
    title: 'two review_queue entries with the same idempotency_key',
    collection: COLLECTIONS.review_queue,
    pair: () => [reviewQueueDoc('dup-review'), reviewQueueDoc('dup-review')],
  },
  {
    id: 'V51',
    title: 'same approver approves the same review twice',
    collection: COLLECTIONS.approvals,
    pair: () => {
      const review_id = new ObjectId();
      const approval = () => ({ _id: new ObjectId(), review_id, approver_id: 'alice', decision: 'approve', created_at: new Date() });
      return [approval(), approval()];
    },
  },
  {
    id: 'V52',
    title: 'two approved documents for one review_id',
    collection: COLLECTIONS.approved,
    pair: () => {
      const review_id = new ObjectId();
      return [approvedDoc(150_000, ['alice'], { review_id }), approvedDoc(150_000, ['bob'], { review_id })];
    },
  },
  {
    id: 'V53',
    title: 'two ledger entries for one source_id',
    collection: COLLECTIONS.ledger,
    pair: () => {
      const source = new ObjectId();
      return [ledgerDoc(source), ledgerDoc(source)];
    },
  },
];

describe('unique indexes', () => {
  it.each(rows)('$id second insert fails with E11000: $title', async ({ collection, pair }) => {
    const [first, second] = pair();
    const coll = t().db.collection(collection);
    await coll.insertOne(first);
    await expectServerError(() => coll.insertOne(second), ERROR_CODES.DUPLICATE_KEY);
    expect(await coll.countDocuments({ _id: second['_id'] })).toBe(0);
  });

  it('V51-control a second approver on the same review is allowed', async () => {
    const coll = t().db.collection(COLLECTIONS.approvals);
    const review_id = new ObjectId();
    await coll.insertOne({ review_id, approver_id: 'alice', decision: 'approve', created_at: new Date() });
    await coll.insertOne({ review_id, approver_id: 'bob', decision: 'approve', created_at: new Date() });
    expect(await coll.countDocuments({ review_id })).toBe(2);
  });

  it('IDX every INDEXES entry exists on the server, unique, under its name', async () => {
    expect(INDEXES).toHaveLength(5);
    for (const index of INDEXES) {
      const found = (await t().db.collection(index.collection).listIndexes().toArray()).find(
        (i) => i['name'] === index.options.name,
      );
      expect(found, `${index.collection}.${index.options.name}`).toBeDefined();
      expect(found!['key']).toEqual(index.key);
      expect(found!['unique']).toBe(true);
    }
  });
});
