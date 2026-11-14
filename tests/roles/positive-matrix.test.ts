/**
 * TEST_PLAN R26: every operation the PRD role table grants each role
 * succeeds when run as that role's real user. Catches a role locked down so
 * tightly the process cannot run.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { ALL_COLLECTIONS, COLLECTIONS, applySchema, type AppRole } from '@escrowops/shared';
import { useTestDb } from '../helpers/index.js';
import { buildApproved, buildIntent } from '../../scripts/lib/redteam-attacks.js';
import { firstEvent, setUpAccess } from './role-helpers.js';

const t = useTestDb('roles_positive');
const handles = {} as Record<AppRole, Db>;
const WATCH_OPTS = { maxAwaitTimeMS: 200 };

beforeAll(async () => {
  await setUpAccess(t());
  for (const role of ['agent', 'approver', 'executor', 'dashboard', 'admin'] as const) {
    handles[role] = (await t().connectAsRole(role)).db(t().dbName);
  }
  // Source data, as the seed script would write it.
  const now = new Date();
  await t().db.collection(COLLECTIONS.customers).insertOne({ _id: 'C-1' as never, name: 'Ada', email: 'ada@example.test', created_at: now });
  await t().db.collection(COLLECTIONS.orders).insertOne({ _id: 'O-1' as never, customer_id: 'C-1', amount_cents: 9_900, created_at: now });
  await t().db.collection(COLLECTIONS.tickets).insertOne({ _id: 'T-1' as never, customer_id: 'C-1', order_id: 'O-1', created_at: now });
  await t().db.collection(COLLECTIONS.policies).insertOne({ version: 1, active: true, created_at: now });
});

describe('R26 agent (escrow_agent)', () => {
  it('R26: find on tickets, orders, customers, policies', async () => {
    for (const name of [COLLECTIONS.tickets, COLLECTIONS.orders, COLLECTIONS.customers, COLLECTIONS.policies]) {
      expect(await handles.agent.collection(name).findOne({}), name).not.toBeNull();
    }
  });

  it('R26: insert into agent_traces, intents and review_queue', async () => {
    await handles.agent
      .collection(COLLECTIONS.agent_traces)
      .insertOne({ trace_id: 'tr-agent', ticket_id: 'T-1', seq: 0, kind: 'tool_call', tool: 'get_ticket', created_at: new Date() });
    await handles.agent
      .collection(COLLECTIONS.intents)
      .insertOne(buildIntent({ amount_cents: 4_200, trace_id: 'tr-agent', ticket_id: 'T-1', order_id: 'O-1', customer_id: 'C-1' }));
    await handles.agent.collection(COLLECTIONS.review_queue).insertOne({
      ...buildIntent({ amount_cents: 500_000, trace_id: 'tr-agent-held', ticket_id: 'T-2', order_id: 'O-2' }),
      tier: 'human_required',
      required_approvals: 2,
      status: 'pending',
      validator_error: { code: 121 },
    });
  });
});

describe('R26 approver (escrow_approver)', () => {
  it('R26: find, update and watch review_queue', async () => {
    const queue = handles.approver.collection(COLLECTIONS.review_queue);
    const event = await firstEvent(queue.watch([{ $match: { operationType: 'insert' } }], WATCH_OPTS), () =>
      t()
        .db.collection(COLLECTIONS.review_queue)
        .insertOne({ ...buildIntent({ amount_cents: 150_000, trace_id: 'tr-watch-rq' }), status: 'pending' }),
    );
    expect(event['operationType']).toBe('insert');
    const id = (event['documentKey'] as { _id: ObjectId })._id;
    expect(await queue.findOne({ _id: id })).not.toBeNull();
    const res = await queue.updateOne({ _id: id }, { $set: { status: 'rejected', updated_at: new Date() } });
    expect(res.modifiedCount).toBe(1);
  });

  it('R26: find and insert on approvals', async () => {
    const approvals = handles.approver.collection(COLLECTIONS.approvals);
    const review_id = new ObjectId();
    await approvals.insertOne({ review_id, approver_id: 'approver-a', decision: 'approve', created_at: new Date() });
    expect(await approvals.countDocuments({ review_id })).toBe(1);
  });

  it('R26: promotion transaction (insert approvals + insert approved + update review_queue)', async () => {
    const proposal = { amount_cents: 150_000, trace_id: 'tr-promote', ticket_id: 'T-9', order_id: 'O-9', idempotency_key: 'k-promote' };
    const review = { ...buildIntent(proposal), status: 'pending' };
    await t().db.collection(COLLECTIONS.review_queue).insertOne(review);

    const client = await t().connectAsRole('approver');
    const db = client.db(t().dbName);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        await db
          .collection(COLLECTIONS.approvals)
          .insertOne({ review_id: review._id, approver_id: 'approver-a', decision: 'approve', created_at: new Date() }, { session });
        await db
          .collection(COLLECTIONS.approved)
          .insertOne(buildApproved({ ...proposal, review_id: review._id, approver_ids: ['approver-a'] }), { session });
        await db
          .collection(COLLECTIONS.review_queue)
          .updateOne({ _id: review._id, status: 'pending' }, { $set: { status: 'approved', updated_at: new Date() } }, { session });
      });
    } finally {
      await session.endSession();
    }
    expect(await t().db.collection(COLLECTIONS.approved).countDocuments({ review_id: review._id })).toBe(1);
    expect((await t().db.collection(COLLECTIONS.review_queue).findOne({ _id: review._id }))?.['status']).toBe('approved');
  });
});

describe('R26 executor (escrow_executor)', () => {
  it('R26: find and watch intents', async () => {
    const intents = handles.executor.collection(COLLECTIONS.intents);
    const event = await firstEvent(intents.watch([{ $match: { operationType: 'insert' } }], WATCH_OPTS), () =>
      t().db.collection(COLLECTIONS.intents).insertOne(buildIntent({ amount_cents: 1_000, trace_id: 'tr-watch-int' })),
    );
    expect(event['operationType']).toBe('insert');
    expect(await intents.findOne({ _id: (event['documentKey'] as { _id: ObjectId })._id })).not.toBeNull();
  });

  it('R26: find and watch approved', async () => {
    const approved = handles.executor.collection(COLLECTIONS.approved);
    const event = await firstEvent(approved.watch([{ $match: { operationType: 'insert' } }], WATCH_OPTS), () =>
      t()
        .db.collection(COLLECTIONS.approved)
        .insertOne(buildApproved({ amount_cents: 150_000, trace_id: 'tr-watch-appr', approver_ids: ['approver-b'] })),
    );
    expect(event['operationType']).toBe('insert');
    expect(await approved.findOne({ _id: (event['documentKey'] as { _id: ObjectId })._id })).not.toBeNull();
  });

  it('R26: find, insert, update on ledger, budgets, executor_state; find on orders', async () => {
    const ex = handles.executor;
    const source_id = new ObjectId();
    const now = new Date();
    await ex.collection(COLLECTIONS.ledger).insertOne({
      source_type: 'intent',
      source_id,
      trace_id: 'tr-ledger',
      order_id: 'O-1',
      customer_id: 'C-1',
      amount_cents: 4_200,
      currency: 'usd',
      idempotency_key: 'k-ledger',
      status: 'pending',
      provider: 'fake',
      created_at: now,
      updated_at: now,
    });
    await ex
      .collection(COLLECTIONS.ledger)
      .updateOne({ source_id, status: 'pending' }, { $set: { status: 'succeeded', provider_refund_id: 're_fake_1', updated_at: new Date() } });
    expect((await ex.collection(COLLECTIONS.ledger).findOne({ source_id }))?.['status']).toBe('succeeded');

    await ex.collection(COLLECTIONS.budgets).insertOne({ _id: '2026-11-14' as never, cap_cents: 100_000, spent_cents: 0 });
    await ex.collection(COLLECTIONS.budgets).updateOne({ _id: '2026-11-14' as never }, { $inc: { spent_cents: 4_200 } });
    expect((await ex.collection(COLLECTIONS.budgets).findOne({ _id: '2026-11-14' as never }))?.['spent_cents']).toBe(4_200);

    // Resume token checkpoint is an upsert (insert + update).
    await ex
      .collection(COLLECTIONS.executor_state)
      .updateOne({ _id: 'intents' as never }, { $set: { resume_token: { _data: 'x' }, updated_at: new Date() } }, { upsert: true });
    await ex
      .collection(COLLECTIONS.executor_state)
      .updateOne({ _id: 'intents' as never }, { $set: { resume_token: { _data: 'y' }, updated_at: new Date() } }, { upsert: true });
    expect((await ex.collection(COLLECTIONS.executor_state).findOne({ _id: 'intents' as never }))?.['resume_token']).toEqual({ _data: 'y' });

    expect(await ex.collection(COLLECTIONS.orders).findOne({ _id: 'O-1' as never })).not.toBeNull();
  });
});

describe('R26 dashboard (escrow_dashboard)', () => {
  it('R26: find on every collection', async () => {
    for (const name of ALL_COLLECTIONS) {
      await handles.dashboard.collection(name).find({}).limit(1).toArray();
    }
  });

  it('R26: watch review_queue and the whole database', async () => {
    const one = await firstEvent(handles.dashboard.collection(COLLECTIONS.review_queue).watch([], WATCH_OPTS), () =>
      t().db.collection(COLLECTIONS.review_queue).insertOne({ ...buildIntent({ amount_cents: 60_000, trace_id: 'tr-dash' }), status: 'pending' }),
    );
    expect(one['operationType']).toBe('insert');
    const all = await firstEvent(handles.dashboard.watch([{ $match: { 'ns.coll': COLLECTIONS.ledger } }], WATCH_OPTS), () =>
      t().db.collection(COLLECTIONS.ledger).insertOne({ source_id: new ObjectId(), trace_id: 'tr-dash', status: 'pending' }),
    );
    expect((all['ns'] as { coll: string }).coll).toBe(COLLECTIONS.ledger);
  });

  it('R26: audit timeline $unionWith across the trail collections (S7)', async () => {
    const trail = [COLLECTIONS.intents, COLLECTIONS.review_queue, COLLECTIONS.approvals, COLLECTIONS.approved, COLLECTIONS.ledger];
    const docs = await handles.dashboard
      .collection(COLLECTIONS.agent_traces)
      .aggregate([...trail.map((coll) => ({ $unionWith: { coll } })), { $limit: 50 }])
      .toArray();
    expect(docs.length).toBeGreaterThan(0);
  });
});

describe('R26 admin (escrow_admin)', () => {
  it('R26: applySchema runs as admin_role (collections, validators, indexes)', async () => {
    const summary = await applySchema(handles.admin);
    expect(summary.created).toEqual([]);
  });

  it('R26: collMod, createIndex, dropIndex, createCollection', async () => {
    const [info] = await t().db.listCollections({ name: COLLECTIONS.budgets }).toArray();
    const options = (info as { options?: { validator?: unknown } } | undefined)?.options ?? {};
    // Re-apply the existing validator: exercises collMod without changing anything.
    await handles.admin.command({ collMod: COLLECTIONS.budgets, validator: options.validator ?? {}, validationLevel: 'strict', validationAction: 'error' });
    await handles.admin.collection(COLLECTIONS.policies).createIndex({ version: 1 }, { name: 'r26_probe' });
    await handles.admin.collection(COLLECTIONS.policies).dropIndex('r26_probe');
    await handles.admin.createCollection('r26_probe_collection');
  });

  it('R26: find, insert, update on policies', async () => {
    const policies = handles.admin.collection(COLLECTIONS.policies);
    const { insertedId } = await policies.insertOne({ version: 2, active: false, created_at: new Date() });
    await policies.updateOne({ _id: insertedId }, { $set: { active: true } });
    expect((await policies.findOne({ _id: insertedId }))?.['active']).toBe(true);
  });
});
