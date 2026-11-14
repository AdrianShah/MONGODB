/**
 * npm run demo:rehearse [-- --runs 3]   (TEST_PLAN section 8, PRD "Definition of done")
 *
 * Runs the whole DEMO.md script end to end with real processes, N times in a row, and checks
 * the invariants after each run. It uses the database in MONGODB_DB and RESETS it, so point it
 * at a rehearsal database: MONGODB_DB=escrowops_rehearsal npm run demo:rehearse
 *
 * Each run: reset -> batch (replay, no model calls) -> 9 auto refunds paid -> $5,000 held ->
 * approver A approves, A again is refused, B approves -> paid -> red team (all denied) ->
 * demo:kill (executor SIGKILLed after the provider call) -> restart -> reconciled ->
 * every refund paid exactly once at the provider and in the ledger.
 *
 * Payments go to its own fake provider (PAYMENTS=fake-http), ports REHEARSAL_PORT..+2 (4790).
 */
import { COLLECTIONS, connectAdmin, loadConfigOrExit, type LedgerDoc } from '@escrowops/shared';
import { run, start, type Proc } from './lib/procs.js';

const config = loadConfigOrExit();
const runsAt = process.argv.indexOf('--runs');
const RUNS = runsAt >= 0 ? Number(process.argv[runsAt + 1]) : 3;
const BASE = Number(process.env['REHEARSAL_PORT'] ?? 4790);
const env = {
  PAYMENTS: 'fake-http',
  FAKE_PROVIDER_URL: `http://127.0.0.1:${BASE}`,
  FAKE_PROVIDER_PORT: String(BASE),
  API_PORT: String(BASE + 1),
  APPROVAL_URL: `http://127.0.0.1:${BASE + 1}`,
  DASHBOARD_PORT: String(BASE + 2),
  NO_COLOR: '1',
};
Object.assign(process.env, env);
const API = env.APPROVAL_URL;
const DASH = `http://127.0.0.1:${BASE + 2}`;

const procs: Proc[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (msg: string) => console.log(`  - ${msg}`);

function check(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(what);
}

async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

async function login(approver: string): Promise<string> {
  const res = await fetch(`${API}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approver_id: approver, password: `${approver}-dev-password` }),
  });
  check(res.ok, `login as ${approver} failed: ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

const approve = (token: string, id: string) =>
  fetch(`${API}/api/reviews/${id}/approve`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });

async function main(): Promise<number> {
  console.log(`Rehearsing the demo ${RUNS} time(s) against database "${config.dbName}" (it will be reset).\n`);
  const setup = await run('setup');
  check(setup.code === 0, `npm run setup failed\n${setup.output}`);

  const fake = start('fake-provider', 'fake-provider');
  const api = start('api', 'api');
  const dash = start('dashboard', 'dashboard');
  procs.push(fake, api, dash);
  await Promise.all([fake.waitFor(/listening/), api.waitFor(/approval service on/), dash.waitFor(/\[dashboard\] http/)]);

  const admin = await connectAdmin(config);
  const db = admin.db(config.dbName);
  const ledger = db.collection<LedgerDoc>(COLLECTIONS.ledger);
  const results: Array<{ run: number; ok: boolean; seconds: number; error?: string }> = [];

  try {
    for (let n = 1; n <= RUNS; n++) {
      const started = Date.now();
      console.log(`Run ${n} of ${RUNS}`);
      let executor: Proc | undefined;
      try {
        const reset = await run('reset');
        check(reset.code === 0, `npm run reset failed\n${reset.output}`);
        check(/fake provider cleared/.test(reset.output), 'reset did not clear the fake provider');
        step('reset (database and fake provider)');

        executor = start('executor', 'executor');
        procs.push(executor);
        await executor.waitFor(/\[executor\] ready/);

        const batch = await run('batch', ['--replay']);
        check(batch.code === 0, `batch failed\n${batch.output}`);
        check(/9 auto, 3 held, 0 declined/.test(batch.output), `unexpected batch outcome\n${batch.output}`);
        check(/code 121/.test(batch.output) && /amount_cents: 500000 — maximum 50000/.test(batch.output), 'batch did not print the 121 for T-1011');
        await until('9 auto refunds paid', async () => (await ledger.countDocuments({ status: 'succeeded' })) >= 9);
        step('batch: 9 auto refunds paid, 3 held, the $5,000 refusal printed');

        const pipeline = (await (await fetch(`${DASH}/api/pipeline`)).json()) as { tickets: Array<{ ticket_id: string; stage: string; review?: { id: string } }> };
        const held = pipeline.tickets.find((t) => t.ticket_id === 'T-1011');
        check(held?.stage === 'held' && held.review, `T-1011 is ${held?.stage}, expected held`);
        const a = await login('approver-a');
        const b = await login('approver-b');
        check((await (await approve(a, held.review.id)).json() as { outcome: string }).outcome === 'recorded', 'first approval was not recorded');
        check((await approve(a, held.review.id)).status === 409, 'second approval by the same approver was not refused');
        check((await (await approve(b, held.review.id)).json() as { outcome: string }).outcome === 'promoted', 'second approver did not promote');
        await until('T-1011 paid', () => ledger.findOne({ ticket_id: 'T-1011', status: 'succeeded' }), 5000);
        step('dual control: A approved (1 of 2), A again refused, B approved, paid');

        const red = await run('redteam', ['--fast']);
        check(red.code === 0, `redteam reported a problem\n${red.output}`);
        check(/Payouts caused: 0/.test(red.output), 'redteam did not report zero payouts');
        step('red team: every attack denied, payouts caused: 0');

        const kill = await run('demo:kill');
        check(kill.code === 0, `demo:kill failed\n${kill.output}`);
        const killed = await executor.exited;
        // Under npm the SIGKILL surfaces as exit code 137 (128 + 9).
        check(killed.signal === 'SIGKILL' || killed.code === 137, `executor was not SIGKILLed (${JSON.stringify(killed)})`);
        check(/CRASH_AT=3 reached/.test(executor.output()), 'executor did not crash at point 3');
        executor = start('executor', 'executor');
        procs.push(executor);
        await executor.waitFor(/reconciled .* for the same key/, 10_000);
        await executor.waitFor(/\[executor\] ready/);
        step('demo:kill: executor killed mid-payout, restarted, reconciled with the same key');

        // Invariants: one refund per paid source at the provider, one succeeded entry per ticket.
        const calls = (await (await fetch(`${env.FAKE_PROVIDER_URL}/calls`)).json()) as Array<{ outcome: string; request: { idempotencyKey: string } }>;
        const created = calls.filter((c) => c.outcome === 'created').map((c) => c.request.idempotencyKey);
        const succeeded = await ledger.find({ status: 'succeeded' }).toArray();
        check(new Set(created).size === created.length, 'the provider created two refunds for one key');
        check(created.length === succeeded.length, `provider created ${created.length} refunds, ledger has ${succeeded.length} succeeded`);
        check(succeeded.every((e) => created.includes(e.source_id)), 'a succeeded ledger entry has no refund at the provider');
        const perTicket = new Map<string, number>();
        for (const e of succeeded) perTicket.set(e.ticket_id, (perTicket.get(e.ticket_id) ?? 0) + 1);
        check([...perTicket.values()].every((v) => v === 1), 'a ticket was paid twice');
        check(succeeded.length === 11, `expected 11 payouts (9 auto, T-1011, demo:kill), got ${succeeded.length}`);
        check(calls.some((c) => c.outcome === 'replayed'), 'the reconcile did not replay the killed payout');
        step(`invariants: ${succeeded.length} payouts, ${created.length} refunds at the provider, none duplicated`);

        const seconds = (Date.now() - started) / 1000;
        results.push({ run: n, ok: true, seconds });
        console.log(`  PASS in ${seconds.toFixed(1)}s\n`);
      } catch (err) {
        const seconds = (Date.now() - started) / 1000;
        results.push({ run: n, ok: false, seconds, error: (err as Error).message });
        console.log(`  FAIL: ${(err as Error).message}\n${executor ? `\nexecutor output:\n${executor.output()}` : ''}`);
      } finally {
        await executor?.stop();
      }
    }
  } finally {
    await admin.close();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed} of ${RUNS} rehearsals passed${passed === RUNS ? ' in a row' : ''}.`);
  return passed === RUNS ? 0 : 1;
}

main()
  .then(async (code) => {
    await Promise.all(procs.map((p) => p.stop()));
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    await Promise.all(procs.map((p) => p.stop()));
    process.exit(1);
  });
