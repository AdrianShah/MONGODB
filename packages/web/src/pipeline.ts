/**
 * S6: one card per ticket, at the stage of its latest run. Read-only, as escrow_dashboard.
 * The dataset is a dozen tickets, so the whole pipeline is recomputed on every change.
 */
import type { Db } from 'mongodb';
import {
  COLLECTIONS,
  type AgentTraceDoc,
  type ApprovedDoc,
  type IntentDoc,
  type LedgerDoc,
  type ReviewQueueDoc,
  type TicketDoc,
} from '@escrowops/shared';
import type { ReviewDoc, ReviewService } from '@escrowops/api';
import type { LedgerSummary, Stage, TicketCard } from './types.js';

const byTrace = <T extends { trace_id: string }>(docs: T[]) => {
  const map = new Map<string, T[]>();
  for (const d of docs) map.set(d.trace_id, [...(map.get(d.trace_id) ?? []), d]);
  return map;
};

export async function loadPipeline(db: Db, reviews: ReviewService): Promise<TicketCard[]> {
  const [tickets, traces, intents, queue, approved, ledger] = await Promise.all([
    db.collection<TicketDoc>(COLLECTIONS.tickets).find().sort({ _id: 1 }).toArray(),
    db
      .collection<AgentTraceDoc>(COLLECTIONS.agent_traces)
      .find({}, { projection: { input: 0 } })
      .sort({ created_at: 1 })
      .toArray(),
    db.collection<IntentDoc>(COLLECTIONS.intents).find().toArray(),
    db.collection<ReviewDoc>(COLLECTIONS.review_queue).find().toArray(),
    db.collection<ApprovedDoc>(COLLECTIONS.approved).find().toArray(),
    db.collection<LedgerDoc>(COLLECTIONS.ledger).find().toArray(),
  ]);

  // The latest run of each ticket: the newest trace_id seen in any of the agent's outputs.
  const latest = new Map<string, { trace_id: string; at: number }>();
  const consider = (ticket_id: string, trace_id: string, at: Date) => {
    const cur = latest.get(ticket_id);
    if (!cur || at.getTime() >= cur.at) latest.set(ticket_id, { trace_id, at: at.getTime() });
  };
  for (const t of traces) consider(t.ticket_id, t.trace_id, t.created_at);
  for (const d of [...intents, ...queue]) consider(d.ticket_id, d.trace_id, d.created_at);

  const tracesBy = byTrace(traces);
  const intentsBy = byTrace(intents);
  const queueBy = byTrace(queue);
  const approvedBy = byTrace(approved);
  const ledgerBy = byTrace(ledger);
  const reviewCards = new Map((await reviews.toCards(queue)).map((c) => [c.id, c]));

  return tickets.map((ticket) => {
    const card: TicketCard = {
      ticket_id: ticket._id,
      subject: ticket.subject,
      customer_id: ticket.customer_id,
      order_id: ticket.order_id,
      stage: 'open',
    };
    const run = latest.get(ticket._id);
    if (!run) return card;
    card.trace_id = run.trace_id;
    card.updated_at = new Date(run.at).toISOString();

    const runTraces = tracesBy.get(run.trace_id) ?? [];
    const intent = intentsBy.get(run.trace_id)?.[0];
    const review = queueBy.get(run.trace_id)?.[0];
    const promoted = approvedBy.get(run.trace_id)?.[0];
    const entries = ledgerBy.get(run.trace_id) ?? [];
    const paid = entries.find((e) => e.status === 'succeeded') ?? entries.find((e) => e.status === 'pending') ?? entries[0];

    card.amount_cents = intent?.amount_cents ?? review?.amount_cents;
    if (review) card.review = reviewCards.get(review._id.toHexString());
    if (paid) card.ledger = summary(paid);

    card.stage = stageOf({ runTraces, intent: !!intent, review, promoted: !!promoted, ledger: paid });
    if (card.stage === 'declined') {
      const decision = runTraces.find((t) => t.kind === 'decision' && t.tool === 'decline_refund');
      card.note = (decision?.output as { reason?: string } | undefined)?.reason;
    } else if (card.stage === 'error') {
      card.note = runTraces.filter((t) => t.kind === 'error').at(-1)?.text;
    } else if (card.stage === 'failed') {
      card.note = paid?.failure_reason;
    }
    return card;
  });
}

function stageOf(run: {
  runTraces: AgentTraceDoc[];
  intent: boolean;
  review?: ReviewQueueDoc;
  promoted: boolean;
  ledger?: LedgerDoc;
}): Stage {
  if (run.ledger?.status === 'succeeded') return 'paid';
  if (run.ledger?.status === 'pending') return 'paying';
  if (run.ledger?.status === 'failed') return 'failed';
  if (run.promoted) return 'approved';
  if (run.review) {
    if (run.review.status === 'pending') return 'held';
    if (run.review.status === 'approved') return 'approved';
    return run.review.status; // rejected | blocked
  }
  if (run.intent) return 'proposed';
  if (run.runTraces.some((t) => t.kind === 'decision' && t.tool === 'decline_refund')) return 'declined';
  if (run.runTraces.some((t) => t.kind === 'error')) return 'error';
  return run.runTraces.length ? 'working' : 'open';
}

function summary(e: LedgerDoc): LedgerSummary {
  return {
    source_id: e.source_id,
    status: e.status,
    amount_cents: e.amount_cents,
    provider: e.provider,
    ...(e.provider_refund_id ? { provider_refund_id: e.provider_refund_id } : {}),
    ...(e.failure_reason ? { failure_reason: e.failure_reason } : {}),
  };
}
