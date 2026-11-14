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

export interface BlockedWrite {
  tool?: string;
  collection?: string;
  operation?: string;
  code?: number;
  codeName?: string;
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
  /** Writes the agent attempted in this run that MongoDB refused (compromised-agent demo), from `rejected_write` traces. */
  blocked_writes?: BlockedWrite[];
  /** Why the agent declined, or what went wrong. */
  note?: string;
  updated_at?: string;
}

export interface TimelineEvent {
  at: string;
  source: 'agent_traces' | 'intents' | 'review_queue' | 'approvals' | 'approved' | 'ledger' | 'kill_switch';
  /** e.g. tool_call, tool_result, reasoning, decision, proposed, held, approve, reject, promoted, pending, succeeded. */
  kind: string;
  summary: string;
  detail?: unknown;
}

export interface BudgetSummary {
  day: string;
  cap_cents: number;
  spent_cents: number;
}

/** Kill switch state, from the latest `kill_switch` record (null: never used). */
export interface FreezeSummary {
  frozen: boolean;
  action: 'freeze' | 'unfreeze';
  actor: string;
  reason: string;
  at: string;
  voided: Array<{ ticket_id: string; amount_cents: number; source_id: string }>;
  in_flight: Array<{ ticket_id: string; amount_cents: number; source_id: string }>;
  /** Pending reviews the freeze rejected. */
  voided_reviews?: number;
  /** True when updateRole also ran (local mongod); false on Atlas, where only the validator holds. */
  role_revoked?: boolean;
}

export type PipelineMessage = {
  type: 'pipeline';
  tickets: TicketCard[];
  budget: BudgetSummary | null;
  /** Optional so older servers and other branches stay compatible. */
  freeze?: FreezeSummary | null;
};
