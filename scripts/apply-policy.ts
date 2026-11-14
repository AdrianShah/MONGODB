/**
 * npm run apply-policy                          re-apply the active policy's validators
 * npm run apply-policy -- --auto-cap 750        new policy version with a $750 auto cap
 *   --single-approver-cap <dollars>  --hard-cap <dollars>  --dry-run
 *
 * Admin connection (MONGODB_URI). The new version becomes the only one the validators accept,
 * so proposals built against the old policy are rejected. `npm run reset` returns to the seed policy.
 */
import { connectAdmin, loadConfigOrExit } from '@escrowops/shared';
import { applyPolicy, formatPolicy, type PolicyChange } from './lib/policy-admin.js';

function dollarsArg(flag: string): number | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  const value = Number(process.argv[i + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} needs a positive dollar amount`);
  return Math.round(value * 100);
}

async function main(): Promise<number> {
  const config = loadConfigOrExit();
  const change: PolicyChange = {
    auto_cap_cents: dollarsArg('--auto-cap'),
    single_approver_cap_cents: dollarsArg('--single-approver-cap'),
    hard_cap_cents: dollarsArg('--hard-cap'),
  };
  const dryRun = process.argv.includes('--dry-run');
  const client = await connectAdmin(config);
  try {
    const result = await applyPolicy(client.db(config.dbName), change, { dryRun });
    console.log(`Active policy before: ${formatPolicy(result.previous)}`);
    console.log(`${dryRun ? 'Would apply' : 'Applied'}:        ${formatPolicy(result.policy)}`);
    if (!result.newVersion) console.log('No cap changed: validators re-applied from the active policy.');
    if (!dryRun) {
      const s = result.schema;
      console.log(`Validators: ${s.updated.length + s.created.length} changed, ${s.unchanged.length} unchanged.`);
      if (result.newVersion) console.log(`Proposals with policy_version ${result.previous.version} are now rejected.`);
    }
    return 0;
  } finally {
    await client.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`apply-policy failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
