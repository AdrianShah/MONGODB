/**
 * TEST_PLAN C11: the executor's connection to MongoDB is cut for 10 s by a TCP proxy. Refunds
 * inserted during the outage are paid after it, exactly once; nothing is missed.
 */
import { createServer, type Server, type Socket, connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MongoClient } from 'mongodb';
import { connectWith, ledgerSourceId } from '@escrowops/shared';
import { Executor, FakeProvider } from '@escrowops/executor';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { insertApproved, insertIntent, ledgerOf, seedOrder, waitFor } from '../executor/fixtures.js';

/** A TCP proxy that can drop every connection and refuse new ones until restored. */
function cuttableProxy(targetHost: string, targetPort: number) {
  const sockets = new Set<Socket>();
  let cut = false;
  const server: Server = createServer((client) => {
    if (cut) return client.destroy();
    const upstream = connect(targetPort, targetHost);
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => s.destroy());
    }
    client.pipe(upstream).pipe(client);
  });
  return {
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port))),
    cut() {
      cut = true;
      for (const s of sockets) s.destroy();
    },
    restore() {
      cut = false;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const t = useTestDb('c11');
let proxy: ReturnType<typeof cuttableProxy>;
let client: MongoClient;
let executor: Executor;
const provider = new FakeProvider();

beforeAll(async () => {
  await setUpAccess(t());
  const target = new URL(t().uri);
  proxy = cuttableProxy(target.hostname, Number(target.port));
  const port = await proxy.listen();
  // directConnection keeps the driver on the proxy instead of the replica set's advertised host.
  const viaProxy = `mongodb://127.0.0.1:${port}/?directConnection=true`;
  const { username, password } = t().config.users.executor;
  client = await connectWith(viaProxy, username, password, t().dbName, { serverSelectionTimeoutMS: 30_000 });
  executor = new Executor({ db: client.db(t().dbName), provider, log: () => {}, staleReconcileEveryMs: 2_000, staleAfterMs: 1_000 });
  await executor.start();
});
afterAll(async () => {
  await executor?.stop().catch(() => {});
  await client?.close().catch(() => {});
  await proxy?.close();
});

describe('C11: Change Stream connection dropped for 10 s', () => {
  it('resumes and pays everything inserted during the outage, exactly once', async () => {
    const order = await seedOrder(t().db);
    const before = await insertIntent(t().db, order, 1000);
    await waitFor(() => ledgerOf(t().db).findOne({ source_id: ledgerSourceId('intents', before._id), status: 'succeeded' }), { what: 'pre-outage payout' });

    proxy.cut();
    const during = [];
    for (let i = 0; i < 3; i++) during.push(await insertIntent(t().db, order, 2000 + i));
    for (let i = 0; i < 2; i++) during.push(await insertApproved(t().db, order, 60_000 + i));
    await new Promise((r) => setTimeout(r, 10_000));
    expect(await ledgerOf(t().db).countDocuments({ status: 'succeeded' })).toBe(1); // nothing could be paid while cut
    proxy.restore();

    await waitFor(async () => (await ledgerOf(t().db).countDocuments({ status: 'succeeded' })) === 6, { timeoutMs: 45_000, what: 'all six paid' });
    const keys = provider.created.map((c) => c.request.idempotencyKey);
    expect(new Set(keys).size).toBe(6);
    expect(keys.sort()).toEqual(
      [before, ...during].map((d) => ledgerSourceId('review_id' in d ? 'approved' : 'intents', d._id)).sort(),
    );
  }, 90_000);
});
