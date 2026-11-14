/** S9: hash chains on agent traces and approvals make later edits detectable. */
import { beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, GENESIS, chainHash, sealRecord, verifyAll, verifyChain, verifyTrace } from '@escrowops/shared';
import { resolveTicket } from '@escrowops/agent';
import { ReviewService } from '@escrowops/api';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { seedDatabase } from '../../scripts/lib/seed-data.js';
import { proposeScript, scriptedModel } from '../agent/fake-model.js';

const t = useTestDb('audit_chain');

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
});

const run = async (ticket: string, order: string, cents: number) =>
  resolveTicket(ticket, {
    db: (await t().connectAsRole('agent')).db(t().dbName),
    model: 'm',
    createMessage: scriptedModel(proposeScript(ticket, order, cents)).createMessage,
  });

describe('chain primitives', () => {
  it('verifies a sealed chain in any order and pinpoints an edit, a deletion and an insertion', () => {
    const a = sealRecord(GENESIS, { _id: 'a', n: 1 });
    const b = sealRecord(a.hash, { _id: 'b', n: 2 });
    const c = sealRecord(b.hash, { _id: 'c', n: 3 });
    expect(verifyChain([c, a, b])).toEqual({ ok: true, checked: 3, problems: [] });

    expect(verifyChain([a, { ...b, n: 99 }, c]).problems.join()).toMatch(/b was changed/);
    expect(verifyChain([a, c]).problems.join()).toMatch(/c not linked/);
    const forged = sealRecord(a.hash, { _id: 'x', n: 7 });
    expect(verifyChain([a, b, c, forged]).problems.join()).toMatch(/forks/);
    expect(chainHash(GENESIS, { k: 1, j: 2 })).toBe(chainHash(GENESIS, { j: 2, k: 1 }));
  });
});

describe('in the database', () => {
  it('an agent trace verifies after the run, and an admin edit to its reasoning is caught', async () => {
    const r = await run('T-1001', 'O-5101', 8900);
    expect(await verifyTrace(t().db, r.trace_id)).toMatchObject({ ok: true, problems: [] });

    // A privileged user quietly rewrites what the model said.
    await t().db.collection(COLLECTIONS.agent_traces).updateOne({ trace_id: r.trace_id, kind: 'decision' }, { $set: { 'output.amount_cents': 100 } });
    const after = await verifyTrace(t().db, r.trace_id);
    expect(after.ok).toBe(false);
    expect(after.problems.join()).toMatch(/was changed after it was written/);
  });

  it('approvals are chained per review; deleting the first approval is caught', async () => {
    const r = await run('T-1011', 'O-5111', 500_000);
    const approver = await t().connectAsRole('approver');
    const reviews = new ReviewService(approver, approver.db(t().dbName));
    const review = await t().db.collection(COLLECTIONS.review_queue).findOne({ trace_id: r.trace_id });
    await reviews.approve(review!['_id'], 'approver-a');
    await reviews.approve(review!['_id'], 'approver-b');
    expect(await verifyTrace(t().db, r.trace_id)).toMatchObject({ ok: true });

    await t().db.collection(COLLECTIONS.approvals).deleteOne({ review_id: review!['_id'], approver_id: 'approver-a' });
    const after = await verifyTrace(t().db, r.trace_id);
    expect(after.problems.join()).toMatch(/approval by approver-b not linked/);
  });

  it('verifyAll reports every broken chain', async () => {
    const report = await verifyAll(t().db);
    expect(report.traces).toBeGreaterThanOrEqual(2);
    expect(report.problems.length).toBeGreaterThanOrEqual(2);
  });
});
