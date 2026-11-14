// TEST_PLAN section 4: exactly-once payouts under SIGKILL.
// Run with: npm run test:chaos   (CHAOS_RUNS=10 for a quicker C5)
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FakeProvider } from "../../src/providers/fake.js";
import { startFakeProviderServer } from "../../src/providers/fake-http.js";
import type { LedgerEntry, OrderDoc, RefundSourceDoc } from "../../src/types.js";
import { createTestDb, insertApproved, insertIntent, seedOrder, waitFor, type TestDb } from "../helpers/db.js";
import { expectKilled, spawnExecutor, type ExecutorProcess } from "./process.js";

const CHAOS_RUNS = Number(process.env.CHAOS_RUNS ?? 50);
const RECOVERY_BUDGET_MS = 5000;

let t: TestDb;
let server: Server;
let providerUrl: string;
let provider: FakeProvider;
const running: ExecutorProcess[] = [];

function executor(env: Record<string, string> = {}) {
  const p = spawnExecutor({
    EXECUTOR_MONGODB_URI: t.executorUri,
    MONGODB_DB: t.dbName,
    PAYMENTS: "fake-http",
    FAKE_PROVIDER_URL: providerUrl,
    ...env,
  });
  running.push(p);
  return p;
}

const ledger = () => t.db.collection<LedgerEntry>("ledger");

/** Waits until every expected source has a succeeded ledger entry. */
async function allPaid(expected: number, timeoutMs = 15_000) {
  await waitFor(async () => (await ledger().countDocuments({ status: "succeeded" })) >= expected, {
    timeoutMs,
    what: `${expected} succeeded ledger entries`,
  });
}

/** The exactly-once assertion: one refund per source at the provider and in the ledger. */
async function assertExactlyOnce(sources: RefundSourceDoc[]) {
  const created = provider.created;
  const createdKeys = created.map((c) => c.request.idempotencyKey);
  expect(new Set(createdKeys).size, "duplicate refunds at the provider").toBe(createdKeys.length);
  expect(createdKeys.sort()).toEqual(sources.map((s) => s.idempotency_key).sort());

  const entries = await ledger().find().toArray();
  expect(entries).toHaveLength(sources.length);
  for (const e of entries) {
    expect(e.status).toBe("succeeded");
    const refund = created.find((c) => c.request.idempotencyKey === e.idempotency_key);
    expect(e.provider_refund_id).toBe(refund?.refundId);
  }
}

beforeAll(async () => {
  t = await createTestDb("escrowops_test_chaos");
  ({ server, url: providerUrl, provider } = await startFakeProviderServer());
});
afterAll(async () => {
  await t?.close();
  server?.close();
});
beforeEach(async () => {
  await t.clear();
  provider.reset();
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((p) => p.stop()));
});

describe("single refund, crash at each point, restart (C1 to C4)", () => {
  for (const point of [1, 2, 3, 4] as const) {
    it(`C${point}: crash at point ${point}`, async () => {
      const order = await seedOrder(t.db);
      const first = executor({ CRASH_AT: String(point) });
      await first.ready;
      const doc = await insertApproved(t.db, order, 150_000);
      await expectKilled(first);

      const restartedAt = Date.now();
      const second = executor();
      await allPaid(1);
      expect(Date.now() - restartedAt, "recovery time").toBeLessThan(RECOVERY_BUDGET_MS);
      await second.ready;
      await assertExactlyOnce([doc]);
    });
  }
});

describe("C5: 20 refunds, random crash point and event, repeated", () => {
  it(`${CHAOS_RUNS} runs with zero duplicates and zero losses`, async () => {
    const outcomes: string[] = [];
    for (let run = 1; run <= CHAOS_RUNS; run++) {
      await t.clear();
      provider.reset();
      const point = 1 + Math.floor(Math.random() * 4);
      const hit = 1 + Math.floor(Math.random() * 20);

      const orders: OrderDoc[] = [];
      for (let i = 0; i < 20; i++) orders.push(await seedOrder(t.db));

      const first = executor({ CRASH_AT: String(point), CRASH_ON_HIT: String(hit) });
      await first.ready;
      const sources: RefundSourceDoc[] = [];
      for (let i = 0; i < 20; i++) {
        sources.push(
          i % 2 === 0
            ? await insertIntent(t.db, orders[i]!, 1000 + i)
            : await insertApproved(t.db, orders[i]!, 60_000 + i),
        );
      }
      await expectKilled(first);

      const second = executor();
      try {
        await allPaid(20);
        await assertExactlyOnce(sources);
      } catch (err) {
        throw new Error(`run ${run} (CRASH_AT=${point}, CRASH_ON_HIT=${hit}) failed: ${(err as Error).message}\n${second.output()}`);
      }
      await second.stop();
      outcomes.push(`${point}@${hit}`);
    }
    console.log(`[chaos] C5: ${outcomes.length} runs, every refund paid exactly once. Crash points: ${outcomes.join(" ")}`);
  });
});

describe("other chaos cases", () => {
  it("C6: crash twice in a row at point 3", async () => {
    const order = await seedOrder(t.db);
    const first = executor({ CRASH_AT: "3" });
    await first.ready;
    const doc = await insertIntent(t.db, order, 4200);
    await expectKilled(first);

    // The second run crashes again while reconciling the same pending entry.
    await expectKilled(executor({ CRASH_AT: "3" }));

    executor();
    await allPaid(1);
    await assertExactlyOnce([doc]);
    expect(provider.calls.filter((c) => c.outcome === "replayed").length).toBeGreaterThanOrEqual(1);
  });

  it("C7: refunds inserted while the executor is down are paid after restart", async () => {
    const order = await seedOrder(t.db);
    const first = executor();
    await first.ready;
    const sources = [await insertIntent(t.db, order, 1000)];
    await allPaid(1);
    await first.stop();
    expect(await t.db.collection("executor_state").countDocuments()).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) sources.push(await insertIntent(t.db, order, 1000 + i));
    executor();
    await allPaid(6);
    await assertExactlyOnce(sources);
  });

  it("C8: resume token deleted while down; the startup sweep pays everything once", async () => {
    const order = await seedOrder(t.db);
    const first = executor();
    await first.ready;
    const sources = [await insertIntent(t.db, order, 1000)];
    await allPaid(1);
    await first.stop();

    for (let i = 0; i < 5; i++) sources.push(await insertApproved(t.db, order, 60_000 + i));
    await t.db.collection("executor_state").deleteMany({});
    const second = executor();
    await allPaid(6);
    await assertExactlyOnce(sources);
    expect(second.output()).toMatch(/sweep found unpaid/);
  });

  it("C9: two executors started at once pay each refund once", async () => {
    const orders: OrderDoc[] = [];
    for (let i = 0; i < 20; i++) orders.push(await seedOrder(t.db));
    const sources: RefundSourceDoc[] = [];
    for (let i = 0; i < 10; i++) sources.push(await insertIntent(t.db, orders[i]!, 1000 + i));

    const a = executor();
    const b = executor();
    await Promise.all([a.ready, b.ready]);
    for (let i = 10; i < 20; i++) sources.push(await insertApproved(t.db, orders[i]!, 60_000 + i));

    await allPaid(20);
    await assertExactlyOnce(sources);
  });
});
