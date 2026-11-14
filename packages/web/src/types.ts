/** Shapes the dashboard server sends to the UI. Type-only; shared by both sides. */
import type { ReviewCard } from '@escrowops/api/card';

export type { ReviewCard };

/** Where a ticket's latest run is. Main path: open, working, proposed or held, approved, paying, paid. */
export type Stage =
  | 'open'
  | 'working'
  | 'proposed'
  | 'held'
  | 'approved'
  | 'paying'
  | 'paid'
  | 'declined'
  | 'rejected'
  | 'blocked'
  | 'failed'
  | 'error';

export interface LedgerSummary {
  source_id: string;
  status: 'pending' | 'succeeded' | 'failed';
  amount_cents: number;
  provider?: string;
  provider_refund_id?: string;
  failure_reason?: string;
}

export interface TicketCard {
  ticket_id: string;
  subject: string;
  customer_id: string;
  order_id: string;
  stage: Stage;
  trace_id?: string;
  amount_cents?: number;
  review?: ReviewCard;
  ledger?: LedgerSummary;
  /** Why the agent declined, or what went wrong. */
  note?: string;
  updated_at?: string;
}

export interface TimelineEvent {
  at: string;
  source: 'agent_traces' | 'intents' | 'review_queue' | 'approvals' | 'approved' | 'ledger';
  /** e.g. tool_call, tool_result, reasoning, decision, proposed, held, approve, reject, promoted, pending, succeeded. */
  kind: string;
  summary: string;
  detail?: unknown;
}

export type PipelineMessage = { type: 'pipeline'; tickets: TicketCard[] };
