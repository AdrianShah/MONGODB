/**
 * T5: change the refund policy. The validators are regenerated from the policy, and the
 * new version becomes the only one they accept, so a proposal built against the old policy
 * is rejected by the server (TEST_PLAN O3). Admin connection only.
 */
import type { Db } from 'mongodb';
import {
  COLLECTIONS,
  DEFAULT_POLICY,
  applySchema,
  assertValidPolicy,
  type ChangeSummary,
  type Policy,
  type PolicyDoc,
} from '@escrowops/shared';

export type PolicyChange = Partial<Pick<Policy, 'auto_cap_cents' | 'single_approver_cap_cents' | 'hard_cap_cents'>>;

export interface ApplyPolicyResult {
  previous: Policy;
  policy: Policy;
  /** False when only re-applying the active policy's validators. */
  newVersion: boolean;
  schema: ChangeSummary;
}

export async function activePolicy(db: Db): Promise<Policy> {
  const doc = await db.collection<PolicyDoc>(COLLECTIONS.policies).findOne({ active: true }, { sort: { version: -1 } });
  if (!doc) return { ...DEFAULT_POLICY };
  return {
    version: doc.version,
    auto_cap_cents: doc.auto_cap_cents,
    single_approver_cap_cents: doc.single_approver_cap_cents,
    hard_cap_cents: doc.hard_cap_cents,
  };
}

/**
 * With no change, regenerates the validators from the active policy. With a change, writes
 * the next version (highest existing + 1), applies its validators, and makes it the only
 * active policy.
 */
export async function applyPolicy(db: Db, change: PolicyChange = {}, opts: { dryRun?: boolean } = {}): Promise<ApplyPolicyResult> {
  const policies = db.collection<PolicyDoc>(COLLECTIONS.policies);
  const previous = await activePolicy(db);
  const changed = Object.entries(change).some(([k, v]) => v !== undefined && v !== previous[k as keyof Policy]);

  let policy = previous;
  if (changed) {
    const [latest] = await policies.find({}, { projection: { version: 1 } }).sort({ version: -1 }).limit(1).toArray();
    policy = {
      ...previous,
      ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
      version: Math.max(latest?.version ?? 0, previous.version) + 1,
    };
  }
  assertValidPolicy(policy);
  if (opts.dryRun) return { previous, policy, newVersion: changed, schema: { created: [], updated: [], unchanged: [] } };

  // Validators first: if this fails, the old policy stays active and consistent.
  const schema = await applySchema(db, policy);
  if (changed) {
    await policies.updateOne(
      { version: policy.version },
      {
        $set: {
          active: true,
          auto_cap_cents: policy.auto_cap_cents,
          single_approver_cap_cents: policy.single_approver_cap_cents,
          hard_cap_cents: policy.hard_cap_cents,
        },
        $setOnInsert: { created_at: new Date() },
      },
      { upsert: true },
    );
    await policies.updateMany({ version: { $ne: policy.version }, active: true }, { $set: { active: false } });
  }
  return { previous, policy, newVersion: changed, schema };
}

const dollars = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function formatPolicy(p: Policy): string {
  return `v${p.version}: auto up to ${dollars(p.auto_cap_cents)}, one approver up to ${dollars(p.single_approver_cap_cents)}, two approvers up to ${dollars(p.hard_cap_cents)}, blocked above`;
}
