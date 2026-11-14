/** Held reviews built the way the agent builds them: a real 121 from the intents validator. Not a test file. */
import { createHash } from 'node:crypto';
import { MongoServerError, ObjectId, type Db } from 'mongodb';
import { COLLECTIONS, DEFAULT_POLICY, REQUIRED_APPROVALS, tierFor, type IntentDoc, type ReviewQueueDoc } from '@escrowops/shared';
import type { FastifyInstance } from 'fastify';
import { loadSeedData } from '../../scripts/lib/seed-data.js';

const seed = loadSeedData();
let n = 0;

/** A pending review for a seeded ticket, carrying the server's own 121 errInfo. */
export async function heldReview(db: Db, ticketId: string, amount_cents: number): Promise<ReviewQueueDoc> {
  const ticket = seed.tickets.find((t) => t._id === ticketId);
  if (!ticket) throw new Error(`no seeded ticket ${ticketId}`);
  const proposal: IntentDoc = {
    _id: new ObjectId(),
    trace_id: `trace-api-${++n}`,
    ticket_id: ticket._id,
    order_id: ticket.order_id,
    customer_id: ticket.customer_id,
    amount_cents,
    currency: 'usd',
    reason: 'Refunding the returned item at its order price, confirmed by support.',
    evidence: [{ kind: 'order_line', ref: ticket.order_id, note: 'Line item price.' }],
    policy_version: DEFAULT_POLICY.version,
    idempotency_key: createHash('sha256').update(`${ticket._id}|${ticket.order_id}|${n}`).digest('hex'),
    created_at: new Date(),
  };
  let errInfo: unknown;
  let errmsg: string | undefined;
  try {
    await db.collection<IntentDoc>(COLLECTIONS.intents).insertOne(proposal);
    throw new Error(`${amount_cents} cents was accepted as an auto refund; pick a larger amount`);
  } catch (err) {
    if (!(err instanceof MongoServerError) || err.code !== 121) throw err;
    errInfo = err.errInfo;
    errmsg = err.errmsg;
  }
  const tier = tierFor(amount_cents);
  const review: ReviewQueueDoc = {
    ...proposal,
    tier,
    required_approvals: tier === 'blocked' ? 2 : REQUIRED_APPROVALS[tier],
    status: 'pending',
    validator_error: { code: 121, ...(errmsg ? { errmsg } : {}), errInfo },
  };
  await db.collection<ReviewQueueDoc>(COLLECTIONS.review_queue).insertOne(review);
  return review;
}

export async function clearDecisions(db: Db): Promise<void> {
  for (const c of [COLLECTIONS.review_queue, COLLECTIONS.approvals, COLLECTIONS.approved, COLLECTIONS.ledger, COLLECTIONS.intents, COLLECTIONS.executor_state]) {
    await db.collection(c).deleteMany({});
  }
}

export async function login(app: FastifyInstance, approver_id: string, password = `${approver_id}-dev-password`): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/login', payload: { approver_id, password } });
  if (res.statusCode !== 200) throw new Error(`login failed for ${approver_id}: ${res.body}`);
  return res.json<{ token: string }>().token;
}

export function decide(app: FastifyInstance, token: string | undefined, reviewId: ObjectId, action: 'approve' | 'reject', payload: object = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/reviews/${reviewId.toHexString()}/${action}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    payload,
  });
}
