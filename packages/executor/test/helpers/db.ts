import { createHash } from "node:crypto";
import { MongoClient, ObjectId, type Db } from "mongodb";
import type { OrderDoc, RefundSourceDoc } from "../../src/types.js";

// TODO: once Phase 1's `npm run setup` exists, call it here instead of this minimal copy,
// so these tests run against the real validators, indexes and roles.

export const ADMIN_URI =
  process.env.MONGODB_TEST_URI ?? "mongodb://admin:admin@127.0.0.1:27017/?directConnection=true";

const EXECUTOR_PASSWORD = "executor-test-pw";

export interface TestDb {
  admin: MongoClient;
  /** The test database, through the admin connection (for seeding and assertions). */
  db: Db;
  dbName: string;
  /** Connection string for the executor user, with only executor_role. */
  executorUri: string;
  executor: MongoClient;
  /** The test database, through the executor's own connection. */
  executorDb: Db;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export async function createTestDb(dbName: string): Promise<TestDb> {
  const admin = await new MongoClient(ADMIN_URI).connect();
  const db = admin.db(dbName);
  await db.dropDatabase();

  for (const name of ["orders", "intents", "approved", "ledger", "budgets", "executor_state"]) {
    await db.createCollection(name);
  }
  await db.collection("ledger").createIndex({ source_id: 1 }, { unique: true });
  await db.collection("ledger").createIndex({ status: 1, updated_at: 1 });
  await db.collection("ledger").createIndex({ order_id: 1, status: 1 });
  await db.collection("intents").createIndex({ idempotency_key: 1 }, { unique: true });
  await db.collection("approved").createIndex({ review_id: 1 }, { unique: true, sparse: true });

  // executor_role from PRD section 7, scoped to this database.
  await db.command({ dropAllUsersFromDatabase: 1 });
  await db.command({ dropAllRolesFromDatabase: 1 });
  const on = (collection: string, actions: string[]) => ({ resource: { db: dbName, collection }, actions });
  await db.command({
    createRole: "executor_role",
    privileges: [
      on("intents", ["find", "changeStream"]),
      on("approved", ["find", "changeStream"]),
      on("ledger", ["find", "insert", "update"]),
      on("budgets", ["find", "insert", "update"]),
      on("executor_state", ["find", "insert", "update"]),
      on("orders", ["find"]),
    ],
    roles: [],
  });
  await db.command({ createUser: "executor", pwd: EXECUTOR_PASSWORD, roles: ["executor_role"] });

  const url = new URL(ADMIN_URI);
  url.username = "executor";
  url.password = EXECUTOR_PASSWORD;
  url.pathname = `/${dbName}`;
  url.searchParams.set("authSource", dbName);
  const executorUri = url.toString();
  const executor = await new MongoClient(executorUri).connect();

  return {
    admin,
    db,
    dbName,
    executorUri,
    executor,
    executorDb: executor.db(dbName),
    async clear() {
      await Promise.all(
        ["orders", "intents", "approved", "ledger", "budgets", "executor_state"].map((c) =>
          db.collection(c).deleteMany({}),
        ),
      );
    },
    async close() {
      await executor.close();
      await admin.close();
    },
  };
}

let seq = 0;

export async function seedOrder(db: Db, overrides: Partial<OrderDoc> = {}): Promise<OrderDoc> {
  seq += 1;
  const order: OrderDoc = {
    _id: `ord_${Date.now().toString(36)}_${seq}`,
    customer_id: "cus_alice",
    amount_cents: 2_000_000,
    payment_ref: `pi_test_${seq}`,
    ...overrides,
  };
  await db.collection<OrderDoc>("orders").insertOne(order);
  return order;
}

export function refundDoc(order: OrderDoc, amount_cents: number, extra: Partial<RefundSourceDoc> = {}): RefundSourceDoc {
  seq += 1;
  const ticket_id = extra.ticket_id ?? `T-${seq}`;
  return {
    _id: new ObjectId(),
    trace_id: `trace_${seq}`,
    ticket_id,
    order_id: order._id,
    customer_id: order.customer_id,
    amount_cents,
    currency: "usd",
    reason: "Item arrived damaged; photo evidence attached by the customer.",
    evidence: [{ kind: "order", order_id: order._id }],
    policy_version: 1,
    idempotency_key: createHash("sha256").update(`${ticket_id}:${order._id}`).digest("hex"),
    created_at: new Date(),
    ...extra,
  };
}

export async function insertIntent(db: Db, order: OrderDoc, amount_cents: number, extra: Partial<RefundSourceDoc> = {}) {
  const doc = refundDoc(order, amount_cents, extra);
  await db.collection<RefundSourceDoc>("intents").insertOne(doc);
  return doc;
}

export async function insertApproved(db: Db, order: OrderDoc, amount_cents: number, extra: Partial<RefundSourceDoc> = {}) {
  const doc = refundDoc(order, amount_cents, {
    review_id: new ObjectId().toHexString(),
    approvals: [{ approver_id: "approver_a" }, { approver_id: "approver_b" }],
    ...extra,
  });
  await db.collection<RefundSourceDoc>("approved").insertOne(doc);
  return doc;
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  { timeoutMs = 5000, intervalMs = 50, what = "condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
