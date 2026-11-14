import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Executor } from "../src/executor.js";
import { FakeProvider } from "../src/providers/fake.js";
import { sourceId, type LedgerEntry } from "../src/types.js";
import { createTestDb, insertApproved, insertIntent, seedOrder, waitFor, type TestDb } from "./helpers/db.js";

let t: TestDb;
let provider: FakeProvider;
let executor: Executor | undefined;
const logs: string[] = [];

const ledger = () => t.db.collection<LedgerEntry>("ledger");
const entryFor = (coll: "intents" | "approved", id: Parameters<typeof sourceId>[1]) =>
  ledger().findOne({ source_id: sourceId(coll, id) });
const settled = (coll: "intents" | "approved", id: Parameters<typeof sourceId>[1]) =>
  waitFor(
    async () => {
      const e = await entryFor(coll, id);
      return e && e.status !== "pending" ? e : undefined;
    },
    { what: `ledger entry for ${coll}:${id} to settle` },
  );

async function startExecutor(opts: Partial<ConstructorParameters<typeof Executor>[0]> = {}) {
  executor = new Executor({
    db: t.executorDb,
    provider,
    log: (l) => logs.push(l),
    retryBaseMs: 10,
    staleReconcileEveryMs: 0,
    ...opts,
  });
  await executor.start();
  return executor;
}

beforeAll(async () => {
  t = await createTestDb("escrowops_test_executor");
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  await t.clear();
  provider = new FakeProvider();
  logs.length = 0;
});
afterEach(async () => {
  await executor?.stop();
  executor = undefined;
});

describe("payout", () => {
  it("I1: pays an auto-approved intent once, through the stream, within 2 s", async () => {
    const order = await seedOrder(t.db);
    await startExecutor();
    const started = Date.now();
    const intent = await insertIntent(t.db, order, 4200);

    const entry = await settled("intents", intent._id);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(entry.status).toBe("succeeded");
    expect(entry.provider_refund_id).toMatch(/^re_fake_/);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.request).toMatchObject({
      paymentRef: order.payment_ref,
      amountCents: 4200,
      idempotencyKey: intent.idempotency_key,
    });
  });

  it("pays a document inserted into approved", async () => {
    const order = await seedOrder(t.db, { amount_cents: 600_000 });
    await startExecutor();
    const doc = await insertApproved(t.db, order, 500_000);
    const entry = await settled("approved", doc._id);
    expect(entry.status).toBe("succeeded");
    expect(provider.created).toHaveLength(1);
  });

  it("saves a resume token after each stream event", async () => {
    const order = await seedOrder(t.db);
    await startExecutor();
    const intent = await insertIntent(t.db, order, 1000);
    await settled("intents", intent._id);
    await executor!.idle();
    const state = await t.db.collection("executor_state").findOne({ _id: "stream:intents" as never });
    expect(state?.resume_token).toBeTruthy();
  });
});

describe("pre-payout checks (E5)", () => {
  it("I11: refuses a refund larger than the order's remaining refundable amount", async () => {
    const order = await seedOrder(t.db, { amount_cents: 30_000 });
    await startExecutor();
    const first = await insertIntent(t.db, order, 20_000);
    expect((await settled("intents", first._id)).status).toBe("succeeded");

    const second = await insertIntent(t.db, order, 20_000);
    const entry = await settled("intents", second._id);
    expect(entry.status).toBe("failed");
    expect(entry.failure_reason).toMatch(/^exceeds_refundable/);
    expect(provider.calls).toHaveLength(1);
  });

  it("counts refunds made before EscrowOps (refunded_cents)", async () => {
    const order = await seedOrder(t.db, { amount_cents: 10_000, refunded_cents: 9_000 });
    await startExecutor();
    const intent = await insertIntent(t.db, order, 2_000);
    expect((await settled("intents", intent._id)).failure_reason).toMatch(/^exceeds_refundable/);
    expect(provider.calls).toHaveLength(0);
  });

  it("I12: refuses when the order belongs to a different customer", async () => {
    const order = await seedOrder(t.db, { customer_id: "cus_bob" });
    await startExecutor();
    const intent = await insertIntent(t.db, order, 1000, { customer_id: "cus_alice" });
    const entry = await settled("intents", intent._id);
    expect(entry.status).toBe("failed");
    expect(entry.failure_reason).toMatch(/^order_customer_mismatch/);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses when the order does not exist", async () => {
    await startExecutor();
    const intent = await insertIntent(t.db, { _id: "ord_missing", customer_id: "cus_alice", amount_cents: 1, payment_ref: "x" }, 1000);
    expect((await settled("intents", intent._id)).failure_reason).toMatch(/^order_not_found/);
  });
});

describe("provider errors", () => {
  it("I13: retries a transient error with the same key and pays once", async () => {
    const order = await seedOrder(t.db);
    provider.failTransiently(2);
    await startExecutor();
    const intent = await insertIntent(t.db, order, 1500);
    const entry = await settled("intents", intent._id);
    expect(entry.status).toBe("succeeded");
    expect(entry.attempts).toBe(3);
    expect(new Set(provider.calls.map((c) => c.request.idempotencyKey)).size).toBe(1);
    expect(provider.created).toHaveLength(1);
  });

  it("leaves the entry pending when transient errors outlast the retries", async () => {
    const order = await seedOrder(t.db);
    provider.failTransiently(100);
    await startExecutor({ maxTransientAttempts: 2 });
    const intent = await insertIntent(t.db, order, 1500);
    await waitFor(async () => provider.calls.length >= 2, { what: "two attempts" });
    await executor!.idle();
    expect((await entryFor("intents", intent._id))?.status).toBe("pending");
  });

  it("I14: records a permanent error as failed and does not retry", async () => {
    const order = await seedOrder(t.db);
    provider.failPermanently("charge_already_refunded");
    await startExecutor();
    const intent = await insertIntent(t.db, order, 1500);
    const entry = await settled("intents", intent._id);
    expect(entry.status).toBe("failed");
    expect(entry.failure_reason).toMatch(/charge_already_refunded/);
    expect(provider.calls).toHaveLength(1);
  });
});

describe("recovery", () => {
  it("E4: the startup sweep pays sources that have no ledger entry", async () => {
    const order = await seedOrder(t.db);
    const a = await insertIntent(t.db, order, 1000);
    const b = await insertApproved(t.db, order, 60_000);
    await startExecutor();
    expect((await settled("intents", a._id)).status).toBe("succeeded");
    expect((await settled("approved", b._id)).status).toBe("succeeded");
    expect(provider.created).toHaveLength(2);
  });

  it("does not pay twice when the same source is seen again after a restart", async () => {
    const order = await seedOrder(t.db);
    await startExecutor();
    const intent = await insertIntent(t.db, order, 1000);
    await settled("intents", intent._id);
    await executor!.stop();

    // Throw away the resume token so the stream replays nothing but the sweep runs again.
    await t.db.collection("executor_state").deleteMany({});
    await startExecutor();
    await executor!.idle();
    expect(provider.calls).toHaveLength(1);
    expect(await ledger().countDocuments()).toBe(1);
  });

  it("E3: a pending entry that passed its checks is retried with the same key, not re-paid", async () => {
    const order = await seedOrder(t.db);
    const intent = await insertIntent(t.db, order, 2500);
    // Simulate a crash after the provider call but before the ledger update.
    const paid = await provider.refund({
      paymentRef: order.payment_ref,
      amountCents: 2500,
      currency: "usd",
      idempotencyKey: intent.idempotency_key,
    });
    const past = new Date(Date.now() - 60_000);
    await ledger().insertOne({
      source_id: sourceId("intents", intent._id),
      source_collection: "intents",
      source_doc_id: intent._id,
      trace_id: intent.trace_id,
      ticket_id: intent.ticket_id,
      order_id: order._id,
      customer_id: order.customer_id,
      amount_cents: 2500,
      currency: "usd",
      idempotency_key: intent.idempotency_key,
      status: "pending",
      checks_passed: true,
      owner: "executor-dead",
      attempts: 1,
      created_at: past,
      updated_at: past,
    });

    await startExecutor();
    const entry = await settled("intents", intent._id);
    expect(entry.status).toBe("succeeded");
    expect(entry.provider_refund_id).toBe(paid.refundId);
    expect(provider.created).toHaveLength(1);
    expect(provider.calls.map((c) => c.outcome)).toEqual(["created", "replayed"]);
  });

  it("E3: a pending entry that never passed its checks is re-checked on reconcile", async () => {
    const order = await seedOrder(t.db, { customer_id: "cus_bob" });
    const intent = await insertIntent(t.db, order, 2500, { customer_id: "cus_alice" });
    const past = new Date(Date.now() - 60_000);
    await ledger().insertOne({
      source_id: sourceId("intents", intent._id),
      source_collection: "intents",
      source_doc_id: intent._id,
      trace_id: intent.trace_id,
      ticket_id: intent.ticket_id,
      order_id: order._id,
      customer_id: "cus_alice",
      amount_cents: 2500,
      currency: "usd",
      idempotency_key: intent.idempotency_key,
      status: "pending",
      checks_passed: false,
      owner: "executor-dead",
      attempts: 0,
      created_at: past,
      updated_at: past,
    });
    await startExecutor();
    expect((await settled("intents", intent._id)).failure_reason).toMatch(/^order_customer_mismatch/);
    expect(provider.calls).toHaveLength(0);
  });

  it("an abandoned pending entry is picked up by the periodic reconcile", async () => {
    const order = await seedOrder(t.db);
    provider.failTransiently(100);
    await startExecutor({ maxTransientAttempts: 1, staleReconcileEveryMs: 100, staleAfterMs: 200 });
    const intent = await insertIntent(t.db, order, 1500);
    await waitFor(async () => provider.calls.length >= 1, { what: "first attempt" });
    provider.failTransiently(0);
    const entry = await settled("intents", intent._id);
    expect(entry.status).toBe("succeeded");
    expect(provider.created).toHaveLength(1);
  });
});
