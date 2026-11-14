/**
 * The review card the approval service and the dashboard send to browsers (S5, S8).
 * Types only, with no runtime imports, so browser code can import it.
 */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'blocked';
export type Tier = 'single_agent' | 'peer_review' | 'human_required' | 'blocked';

/** A precedent as shown on a card: its ID, similarity to the ticket, and what it paid. */
export interface CardPrecedent {
  precedent_id: string;
  score: number | null;
  refund_cents: number | null;
  outcome: string | null;
}

export interface ReviewCard {
  id: string;
  trace_id: string;
  ticket_id: string;
  order_id: string;
  customer_id: string;
  amount_cents: number;
  tier: Tier;
  status: ReviewStatus;
  reason: string;
  evidence: Array<{ kind: string; ref?: string; note?: string; [key: string]: unknown }>;
  /** Validator rules the agent's proposal broke, e.g. ["maximum"]. */
  rules_broken: string[];
  validator_message?: string;
  /** Plain-language reasons it was held, e.g. "precedent_deviation: $449.00 is more than 2x ...". */
  hold_reasons?: string[];
  /** A7: the precedent ceiling the amount was checked against (Atlas Vector Search over past disputes). */
  precedent_check?: {
    ceiling_cents: number | null;
    multiplier: number;
    basis: CardPrecedent[];
    method: string;
  };
  /** A7: precedents the agent cited as evidence. */
  precedents_cited?: CardPrecedent[];
  required_approvals: number;
  approvals: Array<{ approver_id: string; decision: 'approve' | 'reject'; note?: string; at: string }>;
  approved_count: number;
  promotion_error?: string;
  created_at: string;
  updated_at?: string;
}
