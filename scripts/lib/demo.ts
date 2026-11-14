/**
 * Demo helpers (DEMO.md "Kill the worker mid-payout"). Admin connection only.
 */
import { createHash, randomUUID } from 'node:crypto';
import { ObjectId, type Db } from 'mongodb';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  type ApprovedDoc,
  type LedgerDoc,
  type OrderDoc,
  type PolicyDoc,
} from '@escrowops/shared';

export interface ExecutorProcessInfo {
  pid: number;
  host: string;
  instance: string;
  started_at: Date;
}

/** The running executor, as it registered itself in executor_state at startup. */
export async function findExecutor(db: Db): Promise<ExecutorProcessInfo | null> {
  return db.collection<ExecutorProcessInfo & { _id: string }>(COLLECTIONS.executor_state).findOne({ _id: 'process' });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inserts one approved refund (two distinct approvers, as the approval service would) against
 * a seeded order that still has room for it. Its ticket ID is DEMO-KILL-…, so it never collides
 * with the twelve demo tickets' one-payout-per-ticket rule.
 */
export async function queueApprovedRefund(db: Db, amount_cents = 2500): Promise<ApprovedDoc> {
  const orders = await db.collection<OrderDoc>(COLLECTIONS.orders).find({ payment_id: { $exists: true, $ne: '' } }).sort({ _id: 1 }).toArray();
  const committed = new Map<string, number>();
  for (const e of await db.collection<LedgerDoc>(COLLECTIONS.ledger).find({ status: { $in: ['pending', 'succeeded'] } }).toArray()) {
    committed.set(e.order_id, (committed.get(e.order_id) ?? 0) + e.amount_cents);
  }
  const order = orders.find((o) => o.amount_cents - (o.refunded_cents ?? 0) - (committed.get(o._id) ?? 0) >= amount_cents);
  if (!order) throw new Error(`no seeded order has ${amount_cents} cents left to refund; run npm run reset`);

  const policy = await db.collection<PolicyDoc>(COLLECTIONS.policies).findOne({ active: true }, { sort: { version: -1 } });
  const ticket_id = `DEMO-KILL-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  const doc: ApprovedDoc = {
    _id: new ObjectId(),
    trace_id: `demo-kill-${randomUUID()}`,
    ticket_id,
    order_id: order._id,
    customer_id: order.customer_id,
    amount_cents,
    currency: 'usd',
    reason: 'Demo: an approved goodwill refund, queued to show crash recovery mid-payout.',
    evidence: [{ kind: 'order', ref: order._id, note: 'Demo refund against a seeded order.' }],
    policy_version: policy?.version ?? DEFAULT_POLICY.version,
    idempotency_key: createHash('sha256').update(`${ticket_id}|${order._id}`).digest('hex'),
    created_at: now,
    review_id: new ObjectId(),
    approvals: [
      { approver_id: 'approver-a', approved_at: now },
      { approver_id: 'approver-b', approved_at: now },
    ],
  };
  await db.collection<ApprovedDoc>(COLLECTIONS.approved).insertOne(doc);
  return doc;
}

export async function waitUntil(fn: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return fn();
}
