/**
 * S3, S4, S5: approve, reject and promote, as the approver database user.
 *
 * Every decision is one transaction that also updates the review document. That update
 * is what serialises concurrent decisions: two approvals racing on one review write-conflict,
 * the driver retries the loser, and the retry sees the winner's approval (I8).
 *
 * The approval service does not check the tier rules itself. Promotion inserts into
 * `approved`, whose validator demands distinct approvers, a second approver above the
 * single-approver cap, and nothing above the hard cap. If the server refuses (121), the
 * review is marked `blocked` and nothing can pay (I9).
 */
import { MongoServerError, ObjectId, type ClientSession, type Collection, type Db, type MongoClient } from 'mongodb';
import { COLLECTIONS, type ApprovalDoc, type ApprovedDoc, type ReviewQueueDoc } from '@escrowops/shared';

/** A review as the approval service stores it: the agent's document plus decision bookkeeping. */
export type ReviewDoc = ReviewQueueDoc & {
  decided_at?: Date;
  /** Why promotion was refused, when status is `blocked`. */
  promotion_error?: { code: number; errmsg?: string; errInfo?: unknown };
};

export type ReviewStatus = ReviewQueueDoc['status'];

/** What a review card shows (S5) plus approval progress (S8). */
export interface ReviewCard {
  id: string;
  trace_id: string;
  ticket_id: string;
  order_id: string;
  customer_id: string;
  amount_cents: number;
  tier: ReviewQueueDoc['tier'];
  status: ReviewStatus;
  reason: string;
  evidence: ReviewQueueDoc['evidence'];
  /** Validator rules the agent's proposal broke, e.g. ["maximum"]. */
  rules_broken: string[];
  validator_message?: string;
  required_approvals: number;
  approvals: Array<{ approver_id: string; decision: ApprovalDoc['decision']; note?: string; at: string }>;
  approved_count: number;
  promotion_error?: string;
  created_at: string;
  updated_at?: string;
}

export type DecisionOutcome = 'recorded' | 'promoted' | 'rejected' | 'blocked';

export class ReviewError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Test hook for C10: called inside the transaction right after the approval insert. */
export type FaultHook = (point: 'after_approval_insert') => void | Promise<void>;

const isCode = (err: unknown, code: number) => err instanceof MongoServerError && err.code === code;

/** Validator rule names in a 121's errInfo, e.g. ["maximum"] or ["$expr"]. */
export function rulesBroken(errInfo: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'operatorName' && typeof value === 'string' && !['$jsonSchema', 'properties', '$and'].includes(value)) {
          found.add(value);
        }
        walk(value);
      }
    }
  };
  walk(errInfo);
  return [...found];
}

export class ReviewService {
  private readonly reviews: Collection<ReviewDoc>;
  private readonly approvals: Collection<ApprovalDoc>;
  private readonly approved: Collection<ApprovedDoc>;

  constructor(
    private readonly client: MongoClient,
    db: Db,
    private readonly fault?: FaultHook,
  ) {
    this.reviews = db.collection<ReviewDoc>(COLLECTIONS.review_queue);
    this.approvals = db.collection<ApprovalDoc>(COLLECTIONS.approvals);
    this.approved = db.collection<ApprovedDoc>(COLLECTIONS.approved);
  }

  async list(status: ReviewStatus | 'all' = 'pending', limit = 200): Promise<ReviewCard[]> {
    const filter = status === 'all' ? {} : { status };
    const docs = await this.reviews.find(filter).sort({ created_at: -1 }).limit(limit).toArray();
    return this.toCards(docs);
  }

  async get(id: ObjectId): Promise<ReviewCard> {
    const doc = await this.reviews.findOne({ _id: id });
    if (!doc) throw new ReviewError(404, 'not_found', 'review not found');
    return (await this.toCards([doc]))[0]!;
  }

  async approve(id: ObjectId, approverId: string, note?: string): Promise<{ outcome: DecisionOutcome; card: ReviewCard }> {
    try {
      const outcome = await this.inTransaction(async (session) => {
        const review = await this.pendingReview(id, session);
        await this.recordDecision(review, approverId, 'approve', note, session);
        await this.fault?.('after_approval_insert');

        const approves = await this.approvals.find({ review_id: id, decision: 'approve' }, { session }).sort({ created_at: 1 }).toArray();
        const now = new Date();
        if (approves.length < review.required_approvals) {
          await this.reviews.updateOne({ _id: id, status: 'pending' }, { $set: { updated_at: now } }, { session });
          return 'recorded' as const;
        }
        await this.approved.insertOne(promotion(review, approves, now), { session });
        await this.reviews.updateOne({ _id: id, status: 'pending' }, { $set: { status: 'approved', decided_at: now, updated_at: now } }, { session });
        return 'promoted' as const;
      });
      return { outcome, card: await this.get(id) };
    } catch (err) {
      if (!isCode(err, 121)) throw err;
      // The `approved` validator refused the promotion. Record the approval and block the review.
      const refusal = err as MongoServerError;
      await this.inTransaction(async (session) => {
        const review = await this.pendingReview(id, session);
        await this.recordDecision(review, approverId, 'approve', note, session);
        const now = new Date();
        await this.reviews.updateOne(
          { _id: id, status: 'pending' },
          {
            $set: {
              status: 'blocked',
              decided_at: now,
              updated_at: now,
              promotion_error: { code: 121, errmsg: refusal.errmsg ?? refusal.message, errInfo: refusal.errInfo },
            },
          },
          { session },
        );
      });
      return { outcome: 'blocked', card: await this.get(id) };
    }
  }

  async reject(id: ObjectId, approverId: string, note?: string): Promise<{ outcome: DecisionOutcome; card: ReviewCard }> {
    await this.inTransaction(async (session) => {
      const review = await this.pendingReview(id, session);
      await this.recordDecision(review, approverId, 'reject', note, session);
      const now = new Date();
      await this.reviews.updateOne({ _id: id, status: 'pending' }, { $set: { status: 'rejected', decided_at: now, updated_at: now } }, { session });
    });
    return { outcome: 'rejected', card: await this.get(id) };
  }

  /** Cards for a set of reviews, with their approvals. */
  async toCards(docs: ReviewDoc[]): Promise<ReviewCard[]> {
    const approvals = docs.length
      ? await this.approvals.find({ review_id: { $in: docs.map((d) => d._id) } }).sort({ created_at: 1 }).toArray()
      : [];
    return docs.map((doc) => {
      const mine = approvals.filter((a) => a.review_id.equals(doc._id));
      const err = doc.validator_error as { errmsg?: string; errInfo?: unknown } | undefined;
      return {
        id: doc._id.toHexString(),
        trace_id: doc.trace_id,
        ticket_id: doc.ticket_id,
        order_id: doc.order_id,
        customer_id: doc.customer_id,
        amount_cents: doc.amount_cents,
        tier: doc.tier,
        status: doc.status,
        reason: doc.reason,
        evidence: doc.evidence,
        rules_broken: rulesBroken(err?.errInfo),
        ...(err?.errmsg ? { validator_message: err.errmsg } : {}),
        required_approvals: doc.required_approvals,
        approvals: mine.map((a) => ({
          approver_id: a.approver_id,
          decision: a.decision,
          ...(a.note ? { note: a.note } : {}),
          at: a.created_at.toISOString(),
        })),
        approved_count: mine.filter((a) => a.decision === 'approve').length,
        ...(doc.promotion_error ? { promotion_error: rulesBroken(doc.promotion_error.errInfo).join(', ') || 'rejected by validator' } : {}),
        created_at: doc.created_at.toISOString(),
        ...(doc.updated_at ? { updated_at: doc.updated_at.toISOString() } : {}),
      };
    });
  }

  private async inTransaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.client.withSession((session) =>
      session.withTransaction(() => fn(session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } }),
    );
  }

  private async pendingReview(id: ObjectId, session: ClientSession): Promise<ReviewDoc> {
    const review = await this.reviews.findOne({ _id: id }, { session });
    if (!review) throw new ReviewError(404, 'not_found', 'review not found');
    if (review.status !== 'pending') throw new ReviewError(409, `review_${review.status}`, `review is already ${review.status}`);
    return review;
  }

  private async recordDecision(
    review: ReviewDoc,
    approverId: string,
    decision: ApprovalDoc['decision'],
    note: string | undefined,
    session: ClientSession,
  ) {
    try {
      await this.approvals.insertOne(
        { _id: new ObjectId(), review_id: review._id, approver_id: approverId, decision, ...(note ? { note } : {}), created_at: new Date() },
        { session },
      );
    } catch (err) {
      // Unique (review_id, approver_id): one decision per person per review.
      if (isCode(err, 11000)) throw new ReviewError(409, 'already_decided', 'you have already decided on this review');
      throw err;
    }
  }
}

/** The `approved` document for a review: exactly the fields the validator allows. */
function promotion(review: ReviewDoc, approves: ApprovalDoc[], now: Date): ApprovedDoc {
  return {
    _id: new ObjectId(),
    trace_id: review.trace_id,
    ticket_id: review.ticket_id,
    order_id: review.order_id,
    customer_id: review.customer_id,
    amount_cents: review.amount_cents,
    currency: review.currency,
    reason: review.reason,
    evidence: review.evidence,
    policy_version: review.policy_version,
    idempotency_key: review.idempotency_key,
    created_at: now,
    review_id: review._id,
    approvals: approves.map((a) => ({ approver_id: a.approver_id, approved_at: a.created_at })),
  };
}
