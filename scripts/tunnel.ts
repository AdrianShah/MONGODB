/**
 * npm run demo:tunnel  (RUNBOOK.md "Sharing the dashboard")
 *
 * Opens a temporary public HTTPS link to the dashboard running on this machine, using a
 * Cloudflare quick tunnel (no account needed; `brew install cloudflared`). Start
 * `npm run services` first. The link works only while this runs; Ctrl-C closes it, and the
 * next run gets a new link. Everything still runs locally: the approval service, executor
 * and database are not exposed, only the dashboard, which forwards sign-in and decisions.
 *
 * Refuses to start while APPROVERS is unset (the dev passwords are public) or DASHBOARD_PUBLIC is set.
 */
import { spawn, spawnSync } from 'node:child_process';
import { DEFAULT_APPROVERS } from '@escrowops/api';
import { loadEnvFile } from '@escrowops/shared';
import { findTunnelUrl, tunnelProblems } from './lib/tunnel.js';

loadEnvFile();
const port = process.env['DASHBOARD_PORT'] ?? '4100';
const local = `http://127.0.0.1:${port}`;

function fail(lines: string[]): never {
  for (const line of lines) console.error(`[tunnel] ${line}`);
  process.exit(1);
}

const problems = tunnelProblems(process.env);
if (problems.length) fail(['not opening a public link:', ...problems.map((p) => `  - ${p}`)]);

if (spawnSync('cloudflared', ['--version'], { stdio: 'ignore' }).error) {
  fail(['cloudflared is not installed. Install it with: brew install cloudflared']);
}

try {
  const res = await fetch(`${local}/api/config`);
  const { requireLogin } = (await res.json()) as { requireLogin: boolean };
  if (!requireLogin) fail(['the running dashboard does not require a sign-in (DASHBOARD_PUBLIC). Restart npm run services without it.']);
} catch {
  fail([`no dashboard at ${local}. Start it first: npm run services`]);
}

// The running approval service may predate the .env change, so ask it directly whether the
// public dev passwords still sign in.
for (const a of DEFAULT_APPROVERS) {
  const res = await fetch(`${local}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approver_id: a.id, password: a.password }),
  });
  if (res.ok) {
    const cookie = res.headers.get('set-cookie')?.split(';')[0];
    await fetch(`${local}/api/logout`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: '{}' });
    fail([`the running approval service still accepts the dev password for ${a.id}. Restart npm run services after setting APPROVERS.`]);
  }
}

console.log(`[tunnel] opening a public link to ${local} ...`);
const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', local], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '';
let announced = false;
const onData = (chunk: Buffer) => {
  output += chunk.toString();
  const url = !announced && findTunnelUrl(output);
  if (url) {
    announced = true;
    console.log(`\n[tunnel] public dashboard: ${url}`);
    console.log('[tunnel] sign in there as an approver. Anyone with the link can reach the sign-in page.');
    console.log('[tunnel] Ctrl-C closes the link.\n');
  }
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);

const timer = setTimeout(() => {
  if (!announced) {
    console.error(`[tunnel] cloudflared gave no link within 30s:\n${output}`);
    child.kill('SIGTERM');
  }
}, 30_000);

child.on('exit', (code) => {
  clearTimeout(timer);
  if (!announced) {
    const reason = output.trim().split('\n').at(-1) ?? '';
    console.error(`[tunnel] cloudflared: ${reason}`);
    if (/429/.test(reason)) console.error('[tunnel] Cloudflare is rate-limiting quick tunnels from this network; wait a few minutes and retry.');
  }
  console.log(`[tunnel] closed${code ? ` (cloudflared exited with code ${code})` : ''}`);
  process.exit(announced ? 0 : 1);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill('SIGTERM'));
