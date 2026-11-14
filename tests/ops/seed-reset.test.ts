/**
 * O2 (data half) and T4: seeding is idempotent, reset empties run data fast
 * and keeps collections, validators, indexes, roles and users.
 */
import { describe, expect, it } from 'vitest';
import { BSON, ObjectId, type Db, type Document } from 'mongodb';
import { ALL_COLLECTIONS, COLLECTIONS, DEFAULT_POLICY, type CollectionName } from '@escrowops/shared';
import { useTestDb } from '../helpers/index.js';
import {
  RUN_COLLECTIONS,
  SEED_COLLECTIONS,
  loadSeedData,
  resetDatabase,
  seedDatabase,
} from '../../scripts/lib/seed-data.js';

const { EJSON } = BSON;
const t = useTestDb('ops');

/** Canonical EJSON of every document in the seed collections, sorted by _id. */
async function snapshotSeed(db: Db): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of SEED_COLLECTIONS) {
    const docs = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    out[name] = EJSON.stringify(docs, { relaxed: false });
  }
  return out;
}

/** Validator options and index definitions per collection. */
async function snapshotSchema(db: Db): Promise<Record<string, { options: Document; indexes: Document[] }>> {
  const out: Record<string, { options: Document; indexes: Document[] }> = {};
  for (const info of await db.listCollections({}, { nameOnly: false }).toArray()) {
    if (!('options' in info)) continue;
    const indexes = await db.collection(info.name).indexes();
    out[info.name] = {
      options: info.options ?? {},
      indexes: indexes.map(({ v: _v, ...rest }) => rest).sort((a, b) => String(a['name']).localeCompare(String(b['name']))),
    };
  }
  return out;
}

/** One or two junk documents per run collection, with distinct values for every unique-indexed field. */
function junkFor(name: CollectionName, n: number): Document {
  const now = new Date();
  return {
    _id: name === COLLECTIONS.budgets || name === COLLECTIONS.executor_state ? `junk-${name}-${n}` : new ObjectId(),
    junk: true,
    idempotency_key: `junk-${name}-${n}-${new ObjectId().toHexString()}`,
    review_id: new ObjectId(),
    approver_id: `approver-${n}`,
    source_id: new ObjectId(),
    trace_id: `trace-junk-${n}`,
    amount_cents: 99_999_999,
    cap_cents: 1,
    spent_cents: 2,
    created_at: now,
  };
}

async function insertJunk(db: Db): Promise<void> {
  for (const name of RUN_COLLECTIONS) {
    // Bypass validation: junk must land even where Agent A's validators reject it.
    await db.collection(name).insertMany([junkFor(name, 1), junkFor(name, 2)], { bypassDocumentValidation: true });
  }
}

describe('seed', () => {
  it('loads every collection and the active policy', async () => {
    const { db } = t();
    const data = loadSeedData();
    const summary = await seedDatabase(db);

    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    for (const name of ALL_COLLECTIONS) expect(names).toContain(name);

    expect(await db.collection(COLLECTIONS.customers).countDocuments()).toBe(data.customers.length);
    expect(await db.collection(COLLECTIONS.orders).countDocuments()).toBe(data.orders.length);
    expect(await db.collection(COLLECTIONS.tickets).countDocuments()).toBe(12);
    expect(summary.tickets.inserted).toBe(12);

    const active = await db.collection(COLLECTIONS.policies).find({ active: true }).toArray();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      version: DEFAULT_POLICY.version,
      auto_cap_cents: DEFAULT_POLICY.auto_cap_cents,
      single_approver_cap_cents: DEFAULT_POLICY.single_approver_cap_cents,
      hard_cap_cents: DEFAULT_POLICY.hard_cap_cents,
    });
    expect(active[0]!['_id']).toBeInstanceOf(ObjectId);
    expect(active[0]!['created_at']).toBeInstanceOf(Date);

    // Money is stored as integers, dates as BSON dates.
    const order = await db.collection(COLLECTIONS.orders).findOne({ _id: 'O-5111' as never });
    expect(order?.['amount_cents']).toBe(800_000);
    expect(order?.['created_at']).toBeInstanceOf(Date);
    const intCount = await db.collection(COLLECTIONS.orders).countDocuments({ amount_cents: { $type: 'int' } });
    expect(intCount).toBe(data.orders.length);
  });

  it('seeding twice gives identical collection contents (O2)', async () => {
    const { db } = t();
    await seedDatabase(db);
    const before = await snapshotSeed(db);
    const second = await seedDatabase(db);
    expect(await snapshotSeed(db)).toEqual(before);

    for (const r of [second.customers, second.orders, second.tickets]) {
      expect(r.inserted).toBe(0);
      expect(r.updated).toBe(0);
      expect(r.removed).toBe(0);
    }
    expect(second.policy).toMatchObject({ created: false, updated: false, deactivated: 0 });
    expect(second.schema.created).toEqual([]);
    expect(second.schema.updated).toEqual([]);
  });

  it('restores seed documents the pipeline changed and removes strays', async () => {
    const { db } = t();
    await seedDatabase(db);
    const before = await snapshotSeed(db);
    await db.collection(COLLECTIONS.tickets).updateOne({ _id: 'T-1001' as never }, { $set: { status: 'resolved' } });
    await db.collection(COLLECTIONS.orders).updateOne({ _id: 'O-5101' as never }, { $set: { refunded_cents: 8900, status: 'partially_refunded' } });
    await db.collection(COLLECTIONS.tickets).insertOne({ _id: 'T-STRAY' as never, junk: true });
    await db.collection(COLLECTIONS.policies).insertOne({ version: 2, active: true, junk: true });

    const summary = await seedDatabase(db);
    expect(summary.tickets).toMatchObject({ updated: 1, removed: 1 });
    expect(summary.orders).toMatchObject({ updated: 1 });
    expect(summary.policy.deactivated).toBe(1);

    const after = await snapshotSeed(db);
    expect(after['tickets']).toBe(before['tickets']);
    expect(after['orders']).toBe(before['orders']);
    expect(await db.collection(COLLECTIONS.policies).countDocuments({ active: true })).toBe(1);
  });
});

describe('reset', () => {
  it('empties run collections, keeps seed data, validators, indexes, roles and users, in under 10 s', async () => {
    const { db } = t();
    await resetDatabase(db); // start from the same baseline as the demo
    const seedBefore = await snapshotSeed(db);
    const schemaBefore = await snapshotSchema(db);

    await db.command({ createRole: 'ops_test_role', privileges: [], roles: [] });
    await t().createUser('ops_test_user', ['ops_test_role']);
    await insertJunk(db);
    for (const name of RUN_COLLECTIONS) expect(await db.collection(name).countDocuments(), name).toBe(2);
    await db.collection(COLLECTIONS.tickets).updateOne({ _id: 'T-1011' as never }, { $set: { status: 'proposed' } });

    const started = performance.now();
    const summary = await resetDatabase(db);
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(10_000);
    expect(summary.durationMs).toBeLessThan(10_000);
    for (const name of RUN_COLLECTIONS) {
      expect(await db.collection(name).countDocuments(), name).toBe(0);
      expect(summary.cleared[name], name).toBe(2);
    }
    expect(await snapshotSeed(db)).toEqual(seedBefore);
    expect(await snapshotSchema(db)).toEqual(schemaBefore);

    const users = await db.command({ usersInfo: 'ops_test_user' });
    expect(users['users']).toHaveLength(1);
    const roles = await db.command({ rolesInfo: 'ops_test_role' });
    expect(roles['roles']).toHaveLength(1);
    console.log(`reset with junk data took ${elapsed.toFixed(0)} ms`);
  });

  it('touches only run collections and the seed set, and the two cover every collection', () => {
    expect([...RUN_COLLECTIONS].sort()).toEqual(
      ['agent_traces', 'approvals', 'approved', 'budgets', 'executor_state', 'intents', 'kill_switch', 'ledger', 'review_queue'],
    );
    expect([...RUN_COLLECTIONS, ...SEED_COLLECTIONS].sort()).toEqual([...ALL_COLLECTIONS].sort());
  });

  it('does not invalidate a Change Stream open across the reset', async () => {
    const { db } = t();
    await seedDatabase(db);
    await insertJunk(db);
    const stream = db.collection(COLLECTIONS.intents).watch([{ $match: { operationType: 'insert' } }]);
    try {
      await stream.tryNext(); // establish the cursor before the reset
      await resetDatabase(db);
      await db.collection(COLLECTIONS.intents).insertOne({ marker: 'after-reset' }, { bypassDocumentValidation: true });
      const event = await stream.next();
      expect(event.operationType).toBe('insert');
      expect((event as { fullDocument?: Document }).fullDocument?.['marker']).toBe('after-reset');
      expect(stream.closed).toBe(false);
    } finally {
      await stream.close();
      await db.collection(COLLECTIONS.intents).deleteMany({});
    }
  });
});
