/**
 * npm run spike [-- --json] [-- --only=a,c]
 *
 * Runs the Phase 0 checks (tests/spike/checks.ts) against MONGODB_URI, or,
 * when it is unset, against a throwaway in-memory replica set with auth.
 * Prints PASS/FAIL per check; --json also prints the raw findings.
 *
 * MONGODB_URI must carry credentials allowed to create databases, roles and
 * users. Everything happens in a fresh database `eo_spike_*`, dropped at the
 * end. On Atlas, check (a) is expected to FAIL with "not allowed" because
 * custom roles and users are created through the Atlas UI/CLI/Admin API, not
 * with createRole/createUser (see docs/SPIKE.md).
 */
import { loadEnvFile } from '@escrowops/shared';
import { createTestDb } from '../tests/helpers/test-db.js';
import { startTestServer } from '../tests/helpers/server.js';
import { SPIKE_CHECKS } from '../tests/spike/checks.js';

async function main(): Promise<number> {
  loadEnvFile();
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',');

  console.log(process.env['MONGODB_URI'] ? 'Using MONGODB_URI' : 'MONGODB_URI unset: starting in-memory replica set with auth');
  const server = await startTestServer();
  let failures = 0;
  try {
    const t = await createTestDb(server.uri, 'spike');
    try {
      const info = await t.admin.db('admin').command({ buildInfo: 1 });
      const hello = await t.admin.db('admin').command({ hello: 1 });
      console.log(`Server ${String(info['version'])}, replica set ${String(hello['setName'] ?? '(none)')}, database ${t.dbName}\n`);

      for (const check of SPIKE_CHECKS) {
        if (only && !only.includes(check.id)) continue;
        const started = Date.now();
        try {
          const { findings } = await check.run(t);
          console.log(`PASS  ${check.id}. ${check.title} (${Date.now() - started} ms)`);
          if (json) console.log(JSON.stringify(findings, null, 2));
        } catch (err) {
          failures += 1;
          console.log(`FAIL  ${check.id}. ${check.title}`);
          console.log(`      ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      await t.cleanup();
    }
  } finally {
    await server.stop();
  }
  console.log(`\n${failures === 0 ? 'All checks passed' : `${failures} check(s) failed`}`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
