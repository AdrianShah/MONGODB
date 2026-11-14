/**
 * The whole system in one process, each part as its own database user: schema, roles and
 * users, seed data, executor (FakeProvider), approval service and dashboard. Framework-free,
 * so both Vitest and Playwright can use it.
 */
import type { AddressInfo } from 'node:net';
import type { Db } from 'mongodb';
import { buildApiServer, DEFAULT_APPROVERS } from '@escrowops/api';
import { Executor, FakeProvider } from '@escrowops/executor';
import { buildDashboardServer } from '@escrowops/web';
import { setUpAccess } from '../roles/role-helpers.js';
import { seedDatabase } from '../../scripts/lib/seed-data.js';
import { createTestDb, type TestDb } from './test-db.js';

export interface Stack {
  t: TestDb;
  /** Admin view of the database, for seeding proposals and assertions. */
  db: Db;
  /** Agent's view of the database (escrow_agent). */
  agentDb: Db;
  provider: FakeProvider;
  executor: Executor;
  approvalUrl: string;
  dashboardUrl: string;
  stop(): Promise<void>;
}

export async function startStack(
  uri: string,
  opts: { prefix?: string; dashboardPort?: number; distDir?: string; requireLogin?: boolean; dailyBudgetCents?: number } = {},
): Promise<Stack> {
  const t = await createTestDb(uri, opts.prefix ?? 'stack');
  await setUpAccess(t);
  await seedDatabase(t.db);
  const quiet = () => {};

  const provider = new FakeProvider();
  const executor = new Executor({
    db: (await t.connectAsRole('executor')).db(t.dbName),
    provider,
    log: quiet,
    staleReconcileEveryMs: 0,
    ...(opts.dailyBudgetCents ? { dailyBudgetCents: opts.dailyBudgetCents } : {}),
  });
  await executor.start();

  const approverClient = await t.connectAsRole('approver');
  const api = await buildApiServer({ client: approverClient, db: approverClient.db(t.dbName), approvers: DEFAULT_APPROVERS, log: quiet });
  await api.app.listen({ port: 0, host: '127.0.0.1' });
  const approvalUrl = `http://127.0.0.1:${(api.app.server.address() as AddressInfo).port}`;

  const dashClient = await t.connectAsRole('dashboard');
  const dashboard = await buildDashboardServer({
    client: dashClient,
    db: dashClient.db(t.dbName),
    approvalUrl,
    log: quiet,
    requireLogin: opts.requireLogin ?? true,
    ...(opts.distDir ? { distDir: opts.distDir } : {}),
  });
  await dashboard.listen({ port: opts.dashboardPort ?? 0, host: '127.0.0.1' });
  const dashboardUrl = `http://127.0.0.1:${(dashboard.server.address() as AddressInfo).port}`;

  return {
    t,
    db: t.db,
    agentDb: (await t.connectAsRole('agent')).db(t.dbName),
    provider,
    executor,
    approvalUrl,
    dashboardUrl,
    async stop() {
      await dashboard.close();
      await api.app.close();
      await executor.stop();
      await t.cleanup();
    },
  };
}
