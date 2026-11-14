import type { ObjectId } from "mongodb";

// Local copies of the document shapes the executor reads and writes.
// TODO: replace with imports from @escrowops/shared once Phase 1 lands it.

/** Fields shared by `intents` and `approved` (PRD section 7). */
export interface RefundSourceDoc {
  _id: ObjectId;
  trace_id: string;
  ticket_id: string;
  order_id: string;
  customer_id: string;
  amount_cents: number;
  currency: "usd";
  reason: string;
  evidence: object[];
  policy_version: number;
  idempotency_key: string;
  created_at: Date;
  /** Only on `approved`. */
  review_id?: ObjectId | string;
  approvals?: { approver_id: string }[];
}

export type SourceCollection = "intents" | "approved";

/**
 * What the executor needs from an order. `_id` is the order ID that intents
 * reference as `order_id`. `payment_ref` is the Stripe PaymentIntent (or
 * charge) the refund is issued against.
 */
export interface OrderDoc {
  _id: string;
  customer_id: string;
  amount_cents: number;
  payment_ref: string;
  /** Refunded outside EscrowOps before seeding, if any. */
  refunded_cents?: number;
}

export type LedgerStatus = "pending" | "succeeded" | "failed";

export interface LedgerEntry {
  _id?: ObjectId;
  /** `<collection>:<source _id>`; unique index makes one payout per source. */
  source_id: string;
  source_collection: SourceCollection;
  source_doc_id: ObjectId;
  trace_id: string;
  ticket_id: string;
  order_id: string;
  customer_id: string;
  amount_cents: number;
  currency: string;
  idempotency_key: string;
  status: LedgerStatus;
  /** Set once the E5 checks pass; a pending entry with this set may already have been paid. */
  checks_passed: boolean;
  owner: string;
  attempts: number;
  provider?: string;
  provider_refund_id?: string;
  failure_reason?: string;
  created_at: Date;
  updated_at: Date;
}

export interface ExecutorStateDoc {
  _id: string;
  resume_token: unknown;
  updated_at: Date;
}

export const sourceId = (coll: SourceCollection, id: ObjectId): string =>
  `${coll}:${id.toHexString()}`;
