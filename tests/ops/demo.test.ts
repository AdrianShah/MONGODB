/** demo:kill helpers: the queued refund passes the real approved validator and the executor pays it once. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, ledgerSourceId, type LedgerDoc } from '@escrowops/shared';
import { Crasher, Executor, FakeProvider } from '@escrowops/executor';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { seedDatabase } from '../../scripts/lib/seed-data.js';
import { findExecutor, isAlive, queueApprovedRefund } from '../../scripts/lib/demo.js';
import { waitFor } from '../executor/fixtures.js';

const t = useTestDb('demo');
const provider = new FakeProvider();
let executor: Executor;

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
  executor = new Executor({ db: (await t().connectAsRole('executor')).db(t().dbName), provider, log: () => {}, staleReconcileEveryMs: 0 });
  await executor.start();
});
afterAll(async () => {
  await executor?.stop();
});

describe('demo:kill', () => {
  it('queues a valid approved refund against a seeded order, which the executor pays once', async () => {
    const doc = await queueApprovedRefund(t().db, 2500);
    expect(doc.ticket_id).toMatch(/^DEMO-KILL-/);
    expect(new Set(doc.approvals.map((a) => a.approver_id)).size).toBe(2);

    const ledger = t().db.collection<LedgerDoc>(COLLECTIONS.ledger);
    const entry = await waitFor(() => ledger.findOne({ source_id: ledgerSourceId('approved', doc._id), status: 'succeeded' }), {
      what: 'demo refund paid',
    });
    expect(entry.amount_cents).toBe(2500);
    expect(provider.created).toHaveLength(1);
  });

  it('refuses when no seeded order has room left', async () => {
    await expect(queueApprovedRefund(t().db, 1_000_000_000)).rejects.toThrow(/npm run reset/);
  });

  it('finds the executor that registered itself, and tells whether it is alive', async () => {
    expect(await findExecutor(t().db)).toBeNull();
    await t().db.collection<{ _id: string }>(COLLECTIONS.executor_state).insertOne({
      _id: 'process',
      pid: process.pid,
      host: 'here',
      instance: 'x',
      started_at: new Date(),
    } as never);
    expect((await findExecutor(t().db))?.pid).toBe(process.pid);
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 22 + 12345)).toBe(false);
  });

  it('a crasher can be armed at runtime (SIGUSR2)', () => {
    const c = new Crasher(undefined);
    expect(c.armed).toBe(false);
    c.arm(3);
    expect(c.armed).toBe(true);
  });
});
