/**
 * Dashboard: `npm run dashboard` (build the UI first with `npm run web:build`).
 * Connects as the dashboard database user (DASHBOARD_DB_USER), read-only.
 * DASHBOARD_PORT (default 4100), APPROVAL_URL (default http://127.0.0.1:4000).
 * Viewing needs an approver sign-in unless DASHBOARD_PUBLIC=1.
 */
import { connectAs, loadConfigOrExit } from '@escrowops/shared';
import { buildDashboardServer } from './server.js';

const config = loadConfigOrExit();
const port = Number(process.env['DASHBOARD_PORT'] ?? 4100);
const host = process.env['DASHBOARD_HOST'] ?? '127.0.0.1';
const approvalUrl = process.env['APPROVAL_URL'] ?? `http://127.0.0.1:${process.env['API_PORT'] ?? 4000}`;

const client = await connectAs('dashboard', config);
const requireLogin = !['1', 'true', 'yes'].includes((process.env['DASHBOARD_PUBLIC'] ?? '').toLowerCase());
const app = await buildDashboardServer({ client, db: client.db(config.dbName), approvalUrl, requireLogin });

const shutdown = async (signal: string) => {
  console.log(`[dashboard] ${signal}, stopping`);
  await app.close();
  await client.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port, host });
console.log(`[dashboard] http://${host}:${port} (approval service ${approvalUrl}; ${requireLogin ? 'approver sign-in required' : 'public, DASHBOARD_PUBLIC set'})`);
