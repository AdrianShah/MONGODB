/**
 * Refund policy thresholds (PRD section 5).
 *
 * OWNER: Wave 1 Agent A (schema). Wave 0 ships the type and the default.
 * Contract: `Policy` and `DEFAULT_POLICY` keep these names and fields;
 * fields may be added, not renamed or removed.
 *
 * All amounts are integer cents. A refund of `amount_cents` falls into:
 *   amount <= auto_cap_cents                         -> single_agent  (intents)
 *   auto_cap_cents < amount <= single_approver_cap   -> peer_review   (1 approver)
 *   single_approver_cap < amount <= hard_cap_cents   -> human_required (2 distinct approvers)
 *   amount > hard_cap_cents                          -> blocked
 */
export interface Policy {
  /** Written into every proposal as `policy_version`; validators accept only the active one. */
  version: number;
  auto_cap_cents: number;
  single_approver_cap_cents: number;
  hard_cap_cents: number;
}

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({
  version: 1,
  auto_cap_cents: 50_000,
  single_approver_cap_cents: 200_000,
  hard_cap_cents: 1_000_000,
});

/**
 * Throws if the policy cannot be turned into validators: every field must be
 * a positive safe integer and the caps must be strictly increasing.
 */
export function assertValidPolicy(policy: Policy): void {
  const fields = ['version', 'auto_cap_cents', 'single_approver_cap_cents', 'hard_cap_cents'] as const;
  for (const field of fields) {
    const value = policy[field];
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Invalid policy: ${field} must be a positive integer, got ${String(value)}`);
    }
  }
  if (!(policy.auto_cap_cents < policy.single_approver_cap_cents && policy.single_approver_cap_cents < policy.hard_cap_cents)) {
    throw new Error(
      'Invalid policy: caps must satisfy auto_cap_cents < single_approver_cap_cents < hard_cap_cents',
    );
  }
}

/** Approvals a refund of this tier needs before it may reach `approved`. */
export const REQUIRED_APPROVALS = Object.freeze({
  single_agent: 0,
  peer_review: 1,
  human_required: 2,
} as const);

/** Which tier a refund of `amountCents` falls into under `policy` (see the table above). */
export function tierFor(
  amountCents: number,
  policy: Policy = DEFAULT_POLICY,
): 'single_agent' | 'peer_review' | 'human_required' | 'blocked' {
  if (amountCents <= policy.auto_cap_cents) return 'single_agent';
  if (amountCents <= policy.single_approver_cap_cents) return 'peer_review';
  if (amountCents <= policy.hard_cap_cents) return 'human_required';
  return 'blocked';
}
