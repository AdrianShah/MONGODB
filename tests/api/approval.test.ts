/**
 * Approval service (PRD S1 to S5, S8) as escrow_approver on the real schema and seed data.
 * TEST_PLAN I3 to I9, I17, I18, C10, plus the live feed (S2) and an approval-to-payout run (I6).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { MongoClient } from 'mongodb';
import { COLLECTIONS, type ApprovalDoc, type ApprovedDoc } from '@escrowops/shared';
import { buildApiServer, DEFAULT_APPROVERS, type ApiServer, type ReviewCard, type ReviewDoc } from '@escrowops/api';
import { Executor, FakeProvider, type ExecutorLedgerDoc } from '@escrowops/executor';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { seedDatabase } from '../../scripts/lib/seed-data.js';
import { waitFor } from '../executor/fixtures.js';
import { clearDecisions, decide, heldReview, login } from './fixtures.js';

const t = useTestDb('approval');
let api: ApiServer;
let failNextAfterApproval = false;
let a: string;
let b: string;

const approvals = () => t().db.collection<ApprovalDoc>(COLLECTIONS.approvals);
const approved = () => t().db.collection<ApprovedDoc>(COLLECTIONS.approved);
const reviews = () => t().db.collection<ReviewDoc>(COLLECTIONS.review_queue);

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
  const client: MongoClient = await t().connectAsRole('approver');
  api = await buildApiServer({
    client,
    db: client.db(t().dbName),
    approvers: DEFAULT_APPROVERS,
    log: () => {},
    fault: () => {
      if (failNextAfterApproval) {
        failNextAfterApproval = false;
        throw new Error('approval service killed mid-promotion');
      }
    },
  });
  await api.app.ready();
  a = await login(api.app, 'approver-a');
  b = await login(api.app, 'approver-b');
});
afterAll(async () => {
  await api?.app.close();
});
beforeEach(async () => {
  await clearDecisions(t().db);
});

describe('login and sessions (S1)', () => {
  it('I18: an unauthenticated approve is refused with 401 and writes nothing', async () => {
    const review = await heldReview(t().db, 'T-1009', 129_900);
    const res = await decide(api.app, undefined, review._id, 'approve');
    expect(res.statusCode).toBe(401);
    expect(await approvals().countDocuments()).toBe(0);
  });

  it('refuses a wrong password and an unknown approver', async () => {
    for (const payload of [{ approver_id: 'approver-a', password: 'nope' }, { approver_id: 'mallory', password: 'x' }]) {
      expect((await api.app.inject({ method: 'POST', url: '/api/login', payload })).statusCode).toBe(401);
    }
  });

  it('sets an HttpOnly session cookie that works on its own', async () => {
    const res = await api.app.inject({ method: 'POST', url: '/api/login', payload: { approver_id: 'approver-a', password: 'approver-a-dev-password' } });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const me = await api.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookie.split(';')[0]! } });
    expect(me.json()).toEqual({ approver_id: 'approver-a' });
  });

  it('I17: an approver_id in the body is ignored; the session decides who approved', async () => {
    const review = await heldReview(t().db, 'T-1009', 129_900);
    const res = await decide(api.app, a, review._id, 'approve', { approver_id: 'approver-b', note: 'checked the order' });
    expect(res.statusCode).toBe(200);
    expect(await approvals().find().toArray()).toMatchObject([{ approver_id: 'approver-a', decision: 'approve', note: 'checked the order' }]);
  });
});

describe('review cards (S5, S8)', () => {
  it('show amount, tier, reason, evidence, the broken rule and progress', async () => {
    const review = await heldReview(t().db, 'T-1011', 500_000);
    await decide(api.app, a, review._id, 'approve');
    const res = await api.app.inject({ method: 'GET', url: '/api/reviews', headers: { authorization: `Bearer ${b}` } });
    const [card] = res.json<{ reviews: ReviewCard[] }>().reviews;
    expect(card).toMatchObject({
      ticket_id: 'T-1011',
      amount_cents: 500_000,
      tier: 'human_required',
      status: 'pending',
      reason: expect.any(String),
      evidence: [{ kind: 'order_line' }],
      rules_broken: ['maximum'],
      required_approvals: 2,
      approved_count: 1,
      approvals: [{ approver_id: 'approver-a', decision: 'approve' }],
    });
  });
});

describe('approve and promote (S3)', () => {
  it('I3: a $1,299 review is promoted on one approval', async () => {
    const review = await heldReview(t().db, 'T-1009', 129_900);
    const res = await decide(api.app, a, review._id, 'approve');
    expect(res.json()).toMatchObject({ outcome: 'promoted', card: { status: 'approved', approved_count: 1 } });
    expect(await approved().find().toArray()).toMatchObject([
      { review_id: review._id, amount_cents: 129_900, ticket_id: 'T-1009', approvals: [{ approver_id: 'approver-a' }] },
    ]);
  });

  it('I4, I5, I6: $5,000 needs two different approvers', async () => {
    const review = await heldReview(t().db, 'T-1011', 500_000);

    const first = await decide(api.app, a, review._id, 'approve');
    expect(first.json()).toMatchObject({ outcome: 'recorded', card: { approved_count: 1, required_approvals: 2, status: 'pending' } });
    expect(await approved().countDocuments()).toBe(0);

    const again = await decide(api.app, a, review._id, 'approve');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: 'already_decided' });
    expect(await approvals().countDocuments()).toBe(1);

    const second = await decide(api.app, b, review._id, 'approve');
    expect(second.json()).toMatchObject({ outcome: 'promoted', card: { status: 'approved', approved_count: 2 } });
    const [doc] = await approved().find().toArray();
    expect(doc!.approvals.map((x) => x.approver_id).sort()).toEqual(['approver-a', 'approver-b']);
  });

  it('I9: over $10,000, two approvals cannot promote; the review is blocked', async () => {
    const review = await heldReview(t().db, 'T-1011', 1_200_000);
    await decide(api.app, a, review._id, 'approve');
    const second = await decide(api.app, b, review._id, 'approve');
    expect(second.json()).toMatchObject({ outcome: 'blocked', card: { status: 'blocked', promotion_error: expect.stringContaining('maximum') } });
    expect(await approved().countDocuments()).toBe(0);
    expect(await approvals().countDocuments({ review_id: review._id })).toBe(2);
    expect((await decide(api.app, a, review._id, 'approve')).statusCode).toBe(409);
  });
});

describe('reject (S4)', () => {
  it('I7: a rejected review refuses later approvals and never pays', async () => {
    const review = await heldReview(t().db, 'T-1011', 500_000);
    const res = await decide(api.app, a, review._id, 'reject', { note: 'not covered' });
    expect(res.json()).toMatchObject({ outcome: 'rejected', card: { status: 'rejected' } });

    const later = await decide(api.app, b, review._id, 'approve');
    expect(later.statusCode).toBe(409);
    expect(later.json()).toMatchObject({ error: 'review_rejected' });
    expect(await approved().countDocuments()).toBe(0);
  });
});

describe('concurrency and crashes', () => {
  it('I8: two approvers at the same instant on a two-approver review: exactly one promotion', async () => {
    const review = await heldReview(t().db, 'T-1011', 500_000);
    const results = await Promise.all([decide(api.app, a, review._id, 'approve'), decide(api.app, b, review._id, 'approve')]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results.map((r) => r.json().outcome).sort()).toEqual(['promoted', 'recorded']);
    expect(await approved().countDocuments({ review_id: review._id })).toBe(1);
  });

  it('I8: two approvers at the same instant on a one-approver review: one promotes, the other is told it is done', async () => {
    const review = await heldReview(t().db, 'T-1009', 129_900);
    const results = await Promise.all([decide(api.app, a, review._id, 'approve'), decide(api.app, b, review._id, 'approve')]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(await approved().countDocuments({ review_id: review._id })).toBe(1);
  });

  it('C10: killed between the approval insert and promotion: neither happened; a retry promotes once', async () => {
    const review = await heldReview(t().db, 'T-1011', 500_000);
    await decide(api.app, a, review._id, 'approve');

    failNextAfterApproval = true;
    expect((await decide(api.app, b, review._id, 'approve')).statusCode).toBe(500);
    expect(await approvals().countDocuments({ review_id: review._id })).toBe(1);
    expect(await approved().countDocuments()).toBe(0);
    expect((await reviews().findOne({ _id: review._id }))?.status).toBe('pending');

    expect((await decide(api.app, b, review._id, 'approve')).json()).toMatchObject({ outcome: 'promoted' });
    expect(await approved().countDocuments()).toBe(1);
  });
});

describe('live feed (S2)', () => {
  it('sends a snapshot, then each change, to a logged-in WebSocket; refuses anonymous ones', async () => {
    await api.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = api.app.server.address() as AddressInfo;
    const review = await heldReview(t().db, 'T-1011', 500_000);

    const anonymous = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await expect(new Promise((resolve, reject) => { anonymous.on('open', resolve); anonymous.on('error', reject); })).rejects.toThrow(/401/);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${b}` } });
    const messages: Array<{ type: string; reviews?: ReviewCard[]; review?: ReviewCard }> = [];
    ws.on('message', (raw) => messages.push(JSON.parse(String(raw))));
    await waitFor(async () => messages.find((m) => m.type === 'snapshot'), { what: 'snapshot' });
    expect(messages[0]!.reviews!.map((r) => r.id)).toContain(review._id.toHexString());

    await decide(api.app, a, review._id, 'approve');
    const update = await waitFor(
      async () => messages.find((m) => m.type === 'review' && m.review!.id === review._id.toHexString() && m.review!.approved_count === 1),
      { what: '1 of 2 update' },
    );
    expect(update.review).toMatchObject({ status: 'pending', required_approvals: 2 });
    ws.close();
  });
});

describe('approval to payout (I6)', () => {
  it('the second approval is paid by the executor within 2 s', async () => {
    const provider = new FakeProvider();
    const executor = new Executor({
      db: (await t().connectAsRole('executor')).db(t().dbName),
      provider,
      log: () => {},
      staleReconcileEveryMs: 0,
    });
    await executor.start();
    try {
      const review = await heldReview(t().db, 'T-1011', 500_000);
      await decide(api.app, a, review._id, 'approve');
      const started = Date.now();
      await decide(api.app, b, review._id, 'approve');
      const ledger = t().db.collection<ExecutorLedgerDoc>(COLLECTIONS.ledger);
      const entry = await waitFor(() => ledger.findOne({ ticket_id: 'T-1011', status: 'succeeded' }), { what: 'payout' });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(entry).toMatchObject({ source_collection: 'approved', amount_cents: 500_000 });
      expect(provider.created).toHaveLength(1);
    } finally {
      await executor.stop();
    }
  });
});
