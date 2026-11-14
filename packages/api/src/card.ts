/**
 * The review card the approval service and the dashboard send to browsers (S5, S8).
 * Types only, with no runtime imports, so browser code can import it.
 */
export type ReviewStatus = 'pending' | 'approved' | 'rejected' | 'blocked';
export type Tier = 'single_agent' | 'peer_review' | 'human_required' | 'blocked';

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
  required_approvals: number;
  approvals: Array<{ approver_id: string; decision: 'approve' | 'reject'; note?: string; at: string }>;
  approved_count: number;
  promotion_error?: string;
  created_at: string;
  updated_at?: string;
}
