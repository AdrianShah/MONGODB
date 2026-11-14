/**
 * S7: everything that happened to one trace, as ONE aggregation: agent_traces $unionWith
 * intents, review_queue, approvals (joined to their review), approved and ledger, sorted
 * by time. Read-only, as escrow_dashboard.
 */
import type { Db, Document } from 'mongodb';
import { COLLECTIONS, verifyTrace, type ChainCheck } from '@escrowops/shared';
import { rulesBroken } from '@escrowops/api';
import type { TimelineEvent } from './types.js';

const dollars = (cents: unknown) => (typeof cents === 'number' ? `$${(cents / 100).toFixed(2)}` : '');

/** The aggregation itself, exported so it can be shown and tested as the single source of the timeline. */
export function timelinePipeline(traceId: string): Document[] {
  const event = (source: string, kind: unknown, at: string, fields: Document = {}) => ({
    $project: { _id: 0, at, source: { $literal: source }, kind, ...fields },
  });
  return [
    { $match: { trace_id: traceId } },
    event('agent_traces', '$kind', '$created_at', { seq: 1, tool: 1, input: 1, output: 1, text: 1 }),
    {
      $unionWith: {
        coll: COLLECTIONS.intents,
        pipeline: [{ $match: { trace_id: traceId } }, event('intents', { $literal: 'proposed' }, '$created_at', { amount_cents: 1 })],
      },
    },
    {
      $unionWith: {
        coll: COLLECTIONS.review_queue,
        pipeline: [
          { $match: { trace_id: traceId } },
          event('review_queue', { $literal: 'held' }, '$created_at', {
            amount_cents: 1,
            tier: 1,
            required_approvals: 1,
            errInfo: '$validator_error.errInfo',
          }),
        ],
      },
    },
    {
      $unionWith: {
        coll: COLLECTIONS.review_queue,
        pipeline: [
          { $match: { trace_id: traceId, decided_at: { $exists: true } } },
          event('review_queue', '$status', '$decided_at', { errInfo: '$promotion_error.errInfo' }),
        ],
      },
    },
    {
      $unionWith: {
        coll: COLLECTIONS.approvals,
        pipeline: [
          { $lookup: { from: COLLECTIONS.review_queue, localField: 'review_id', foreignField: '_id', as: 'review' } },
          { $match: { 'review.trace_id': traceId } },
          event('approvals', '$decision', '$created_at', { approver_id: 1, note: 1 }),
        ],
      },
    },
    {
      $unionWith: {
        coll: COLLECTIONS.approved,
        pipeline: [
          { $match: { trace_id: traceId } },
          event('approved', { $literal: 'promoted' }, '$created_at', { amount_cents: 1, approvers: '$approvals.approver_id' }),
        ],
      },
    },
    {
      $unionWith: {
        coll: COLLECTIONS.ledger,
        pipeline: [{ $match: { trace_id: traceId } }, event('ledger', { $literal: 'pending' }, '$created_at', { amount_cents: 1, source_id: 1 })],
      },
    },
    {
      $unionWith: {
        coll: COLLECTIONS.ledger,
        pipeline: [
          { $match: { trace_id: traceId, status: { $in: ['succeeded', 'failed'] } } },
          event('ledger', '$status', '$updated_at', { amount_cents: 1, provider: 1, provider_refund_id: 1, failure_reason: 1 }),
        ],
      },
    },
    { $sort: { at: 1, seq: 1 } },
  ];
}

export async function loadTimeline(db: Db, traceId: string): Promise<{ events: TimelineEvent[]; integrity: ChainCheck }> {
  const integrity = await verifyTrace(db, traceId);
  const rows = await db.collection(COLLECTIONS.agent_traces).aggregate(timelinePipeline(traceId)).toArray();
  const events = rows.map((r) => {
    const { at, source, kind, errInfo, ...rest } = r as Document & { at: Date; source: TimelineEvent['source']; kind: string };
    const rules = errInfo ? rulesBroken(errInfo) : [];
    return {
      at: at.toISOString(),
      source,
      kind,
      summary: describe(source, kind, rest, rules),
      detail: { ...rest, ...(rules.length ? { rules_broken: rules } : {}) },
    };
  });
  return { events, integrity };
}

function describe(source: string, kind: string, r: Document, rules: string[]): string {
  switch (source) {
    case 'agent_traces':
      if (kind === 'tool_call') return `Agent called ${r['tool']}`;
      if (kind === 'tool_result') return `${r['tool']} returned`;
      if (kind === 'decision') {
        const out = (r['output'] ?? {}) as Document;
        if (out['status'] === 'declined') return `Agent declined: ${out['reason']}`;
        if (out['status'] === 'held') return `Agent proposed ${dollars(out['amount_cents'])}; the database refused it as an auto refund (${(out['rules'] as string[] | undefined)?.join(', ') || '121'})`;
        if (out['status'] === 'proposed') return `Agent proposed ${dollars(out['amount_cents'])}; accepted as an auto refund`;
        return `Agent decision: ${out['status']}`;
      }
      if (kind === 'reasoning') return `Agent: ${String(r['text'] ?? '').slice(0, 200)}`;
      if (kind === 'error') return `Agent error: ${r['text']}`;
      if (kind === 'rejected_write') {
        const out = (r['output'] ?? {}) as Document;
        const amount = typeof out['amount_cents'] === 'number' ? ` ${dollars(out['amount_cents'])}` : '';
        const why = (out['violations'] as string[] | undefined)?.length ? `: ${(out['violations'] as string[]).join('; ')}` : '';
        return `Agent tried ${r['tool']}${amount} (${out['operation']} on ${out['collection']}) → MongoDB rejected (code ${out['code']} ${out['codeName'] ?? ''})${why}`;
      }
      return kind;
    case 'intents':
      return `Auto refund ${dollars(r['amount_cents'])} written to intents`;
    case 'review_queue':
      if (kind === 'held') return `Held for review: ${dollars(r['amount_cents'])}, ${r['tier']}, needs ${r['required_approvals']} approval(s)${rules.length ? `; broke ${rules.join(', ')}` : ''}`;
      if (kind === 'blocked') return `Promotion refused by the approved validator${rules.length ? ` (${rules.join(', ')})` : ''}; blocked`;
      return `Review ${kind}`;
    case 'approvals':
      return `${r['approver_id']} ${kind === 'approve' ? 'approved' : 'rejected'}${r['note'] ? `: ${r['note']}` : ''}`;
    case 'approved':
      return `Promoted to approved by ${(r['approvers'] as string[] | undefined)?.join(' and ')}`;
    case 'ledger':
      if (kind === 'pending') return `Executor started payout ${dollars(r['amount_cents'])} (${r['source_id']})`;
      if (kind === 'succeeded') return `Paid: ${r['provider']} refund ${r['provider_refund_id']}`;
      return `Payout failed: ${r['failure_reason']}`;
    default:
      return kind;
  }
}
