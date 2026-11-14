/**
 * npm run services  (DEMO.md "Before going on": the processes behind the dashboard)
 *
 * Starts the approval service and the dashboard, plus the fake payment provider when
 * PAYMENTS=fake-http points at this machine. Builds the UI first if it has not been built.
 * The executor is left to its own terminal (npm run executor) so it can be killed and
 * restarted on stage; pass --with-executor to run it here too. Ctrl-C stops everything.
 */
import { existsSync } from 'node:fs';
import { loadEnvFile } from '@escrowops/shared';
import { run, start, type Proc } from './lib/procs.js';

loadEnvFile();
const withExecutor = process.argv.includes('--with-executor');
const procs: Proc[] = [];

async function main() {
  if (!existsSync('packages/web/dist/index.html')) {
    console.log('[services] building the dashboard UI...');
    const build = await run('web:build');
    if (build.code !== 0) throw new Error(`UI build failed\n${build.output}`);
  }

  const fakeUrl = process.env['FAKE_PROVIDER_URL'];
  if (process.env['PAYMENTS'] === 'fake-http' && fakeUrl && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(fakeUrl)) {
    const port = new URL(fakeUrl).port || '80';
    const fake = start('fake-provider', 'fake-provider', [], { echo: true, colorIndex: 4, env: { FAKE_PROVIDER_PORT: port } });
    procs.push(fake);
    await fake.waitFor(/listening/);
  }

  const api = start('api', 'api', [], { echo: true, colorIndex: 0 });
  procs.push(api);
  await api.waitFor(/approval service on/);

  const dashboard = start('dashboard', 'dashboard', [], { echo: true, colorIndex: 1 });
  procs.push(dashboard);
  await dashboard.waitFor(/\[dashboard\] http/);

  if (withExecutor) {
    const executor = start('executor', 'executor', [], { echo: true, colorIndex: 2 });
    procs.push(executor);
    await executor.waitFor(/\[executor\] ready/);
  }

  const port = process.env['DASHBOARD_PORT'] ?? '4100';
  console.log(`\n[services] ready. Dashboard: http://127.0.0.1:${port}`);
  if (!withExecutor) console.log('[services] start the executor in its own terminal: npm run executor');

  for (const p of procs) {
    void p.exited.then(({ code, signal }) => {
      console.log(`[services] ${p.name} exited (code ${code}, signal ${signal}); stopping everything`);
      void shutdown(1);
    });
  }
}

let stopping = false;
async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  await Promise.all(procs.map((p) => p.stop()));
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

main().catch((err: unknown) => {
  console.error(`[services] ${err instanceof Error ? err.message : String(err)}`);
  void shutdown(1);
});
