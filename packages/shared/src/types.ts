/**
 * Document shapes for every collection in PRD section 7.
 *
 * Conventions:
 * - Money is always integer cents in a field ending `_cents` (int or long on
 *   the server; validators reject doubles).
 * - Source data (tickets, orders, customers) uses readable string IDs such as
 *   "T-1001"; everything the pipeline writes uses ObjectId `_id`s.
 * - Timestamps are BSON dates (`Date` in JS), never strings.
 *
 * These types describe what the code writes. The validators in schema.ts are
 * the source of truth for what the server accepts; when they disagree, the
 * validator wins and this file should be fixed.
 */
import type { ObjectId } from 'mongodb';
import type { CollectionName } from './collections.js';
import type { KillSwitchDoc } from './killswitch.js';

export type Currency = 'usd';

/** Policy tier a refund falls into (PRD section 5). */
export type Tier = 'single_agent' | 'peer_review' | 'human_required' | 'blocked';

// ---------------------------------------------------------------------------
// Source data (written by the seed script, read by the agent)
// ---------------------------------------------------------------------------

export interface CustomerDoc {
  _id: string;
  name: string;
  email: string;
  created_at: Date;
}

export interface OrderItem {
  sku: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
}

export interface OrderDoc {
  _id: string;
  customer_id: string;
  items: OrderItem[];
  amount_cents: number;
  /** Total already refunded; the executor checks this before paying (E5). */
  refunded_cents: number;
  currency: Currency;
  /** Payment the refund is issued against (Stripe PaymentIntent ID, or a fake ID in seed data). */
  payment_id: string;
  status: 'paid' | 'partially_refunded' | 'refunded';
  created_at: Date;
}

export interface TicketDoc {
  _id: string;
  customer_id: string;
  order_id: string;
  subject: string;
  body: string;
  status: 'open' | 'proposed' | 'declined' | 'resolved';
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface PolicyDoc {
  _id: ObjectId;
  version: number;
  active: boolean;
  auto_cap_cents: number;
  single_approver_cap_cents: number;
  hard_cap_cents: number;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Agent output
// ---------------------------------------------------------------------------

export interface AgentTraceDoc {
  _id: ObjectId;
  trace_id: string;
  ticket_id: string;
  /** Order of events within one trace, starting at 0. */
  seq: number;
  /** `rejected_write`: the server refused a write the agent attempted (code, rule), recorded by the tool harness. */
  kind: 'tool_call' | 'tool_result' | 'reasoning' | 'decision' | 'error' | 'rejected_write';
  tool?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
  created_at: Date;
  /** S9 hash chain per trace_id (see chain.ts). */
  prev_hash?: string;
  hash?: string;
}

/** One piece of evidence the agent cites. The validator only requires an object. */
export interface Evidence {
  kind: string;
  ref?: string;
  note?: string;
  [key: string]: unknown;
}

/** Fields shared by intents, review_queue and approved. */
export interface RefundProposal {
  trace_id: string;
  ticket_id: string;
  order_id: string;
  customer_id: string;
  amount_cents: number;
  currency: Currency;
  reason: string;
  evidence: Evidence[];
  policy_version: number;
  /** Hash of ticket ID and order ID (A4). Unique per collection. */
  idempotency_key: string;
  created_at: Date;
  /**
   * A7: the precedent ceiling this amount was checked against, computed by the tool layer
   * from the ticket text (not from the model). Required on `intents`, whose validator refuses
   * an amount above `ceiling_cents`.
   */
  precedent_check?: PrecedentCheck;
  /** A7: the precedents the agent cited as evidence, with their similarity and amounts. */
  precedents_cited?: PrecedentRef[];
}

/** A precedent as recorded on a proposal. */
export interface PrecedentRef {
  precedent_id: string;
  /** Similarity to the ticket, or null when the agent cited one the search did not return. */
  score: number | null;
  refund_cents: number | null;
  outcome: string | null;
}

/** A7 deviation guard (see precedent.ts). */
export interface PrecedentCheck {
  /** Largest amount the comparable precedents support, or null when there are none. */
  ceiling_cents: number | null;
  /** ceiling = multiplier x the largest refund among `basis`. */
  multiplier: number;
  /** The most similar refunded precedents the ceiling rests on. */
  basis: PrecedentRef[];
  /** How they were found, e.g. "atlas_vector_search:voyage-3.5". */
  method: string;
}

/** `intents`: auto-approvable proposals. Exactly the PRD validator's fields, nothing else. */
export interface IntentDoc extends RefundProposal {
  _id: ObjectId;
}

/** The server's validation error, stored on a held proposal (A2). */
export interface ValidatorErrorRecord {
  code: number;
  errmsg?: string;
  errInfo?: unknown;
}

export interface ReviewQueueDoc extends RefundProposal {
  _id: ObjectId;
  tier: Tier;
  required_approvals: number;
  status: 'pending' | 'approved' | 'rejected' | 'blocked';
  /** Set when the server refused the proposal as an automatic refund. */
  validator_error?: ValidatorErrorRecord;
  /** Plain-language reasons this proposal was held, e.g. a precedent deviation (A7). */
  hold_reasons?: string[];
  updated_at?: Date;
  /** Set when the kill switch voided this pending review: the `kill_switch` record and why. */
  voided_by?: ObjectId;
  void_reason?: string;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalDoc {
  _id: ObjectId;
  review_id: ObjectId;
  approver_id: string;
  decision: 'approve' | 'reject';
  note?: string;
  created_at: Date;
  /** S9 hash chain per review_id (see chain.ts). */
  prev_hash?: string;
  hash?: string;
}

export interface ApprovalEntry {
  approver_id: string;
  approved_at: Date;
}

/** `approved`: fully approved refunds, inserted once per review. */
export interface ApprovedDoc extends RefundProposal {
  _id: ObjectId;
  review_id: ObjectId;
  approvals: ApprovalEntry[];
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/**
 * `ledger`: one document per source document, written only by the executor
 * (PRD section 7, "Ledger entry"). The dashboard's audit timeline reads this shape.
 */
export interface LedgerDoc {
  _id: ObjectId;
  /**
   * `"<collection>:<source _id as hex>"`, e.g. `intents:66f0…`. Unique: one payout
   * per source. Also the idempotency key sent to the payment provider.
   */
  source_id: string;
  source_collection: 'intents' | 'approved';
  /** `_id` of the intent or approved document. */
  source_doc_id: ObjectId;
  trace_id: string;
  ticket_id: string;
  order_id: string;
  customer_id: string;
  amount_cents: number;
  currency: Currency;
  status: 'pending' | 'succeeded' | 'failed';
  /** Set once the pre-payout checks pass. A pending entry with this set may already have been paid. */
  checks_passed: boolean;
  /** The executor instance that last claimed this entry. */
  owner: string;
  /** Provider calls made so far. */
  attempts: number;
  provider: string;
  provider_refund_id?: string;
  failure_reason?: string;
  /** Set on an entry the kill switch voided: the `kill_switch` record that did it (killswitch.ts). */
  voided_by?: ObjectId;
  created_at: Date;
  updated_at: Date;
}

/** The ledger `source_id` for a source document. */
export function ledgerSourceId(collection: LedgerDoc['source_collection'], id: ObjectId): string {
  return `${collection}:${id.toHexString()}`;
}

/** `budgets`: one document per day, `_id` is the UTC date "YYYY-MM-DD". */
export interface BudgetDoc {
  _id: string;
  cap_cents: number;
  spent_cents: number;
  updated_at?: Date;
}

/** `precedents` (A7): a past resolved dispute, embedded for Atlas Vector Search. */
export interface PrecedentDoc {
  _id: string;
  category: string;
  summary: string;
  outcome: 'refunded' | 'partial' | 'declined';
  refund_cents: number;
  /** What the decision rested on, e.g. "refund the damaged line item only". */
  rationale: string;
  decided_at: Date;
  /** Vector for Atlas Vector Search, made by `embedding_model` (Voyage, or the local hash). */
  embedding: number[];
  /** Which model made `embedding`; absent on documents seeded before Voyage support (= local). */
  embedding_model?: string;
}

/** `executor_state`: one document per watched stream, `_id` is the stream name. */
export interface ExecutorStateDoc {
  _id: string;
  resume_token: unknown;
  updated_at: Date;
}

// ---------------------------------------------------------------------------
// Lookups and shared helpers
// ---------------------------------------------------------------------------

/** Maps each collection name to its document type: `db.collection<CollectionDocs['intents']>(...)`. */
export interface CollectionDocs {
  tickets: TicketDoc;
  orders: OrderDoc;
  customers: CustomerDoc;
  policies: PolicyDoc;
  agent_traces: AgentTraceDoc;
  intents: IntentDoc;
  review_queue: ReviewQueueDoc;
  approvals: ApprovalDoc;
  approved: ApprovedDoc;
  ledger: LedgerDoc;
  budgets: BudgetDoc;
  executor_state: ExecutorStateDoc;
  precedents: PrecedentDoc;
  kill_switch: KillSwitchDoc;
}

// Compile-time check that CollectionDocs covers exactly the names in COLLECTIONS.
type _AssertSameKeys<A, B> = [Exclude<A, B>, Exclude<B, A>] extends [never, never] ? true : never;
const _collectionDocsComplete: _AssertSameKeys<keyof CollectionDocs, CollectionName> = true;
void _collectionDocsComplete;

/**
 * What an idempotent setup step did. Used by applySchema, applyRoles and
 * ensureUsers so `npm run setup` can report "no changes" on a second run (O1).
 */
export interface ChangeSummary {
  created: string[];
  updated: string[];
  unchanged: string[];
}

export function emptyChangeSummary(): ChangeSummary {
  return { created: [], updated: [], unchanged: [] };
}

export function hasChanges(summary: ChangeSummary): boolean {
  return summary.created.length > 0 || summary.updated.length > 0;
}
