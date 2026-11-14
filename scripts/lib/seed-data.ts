/**
 * Demo dataset (data/seed/*.json) plus the seed and reset logic behind
 * `npm run seed` and `npm run reset`.
 *
 * - `loadSeedData()` reads and validates the JSON. It throws `SeedDataError`
 *   listing every problem: a broken reference, an expected refund larger than
 *   the order's refundable amount, a wrong tier split, and so on.
 * - `seedDatabase(db)` applies the schema, then upserts customers, orders,
 *   tickets and the active policy. Idempotent: a second run changes nothing.
 * - `resetDatabase(db)` empties every run collection with `deleteMany` (never
 *   `drop`, so validators, indexes and Change Stream watchers survive), then
 *   re-seeds.
 *
 * The script files are thin wrappers that load config and connect; tests call
 * these functions directly with a `Db`.
 *
 * JSON files are Extended JSON (dates as `{"$date": "..."}`), parsed with
 * `BSON.EJSON`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { BSON, type AnyBulkWriteOperation, type Db, type Document } from 'mongodb';
import {
  COLLECTIONS,
  ALL_COLLECTIONS,
  DEFAULT_POLICY,
  applySchema,
  tierFor,
  type ChangeSummary,
  type CollectionName,
  type CustomerDoc,
  type OrderDoc,
  type Policy,
  type PolicyDoc,
  type TicketDoc,
  type Tier,
} from '@escrowops/shared';

const { EJSON } = BSON;

/** Directory holding customers.json, orders.json, tickets.json, expected.json. */
export const SEED_DIR = fileURLToPath(new URL('../../data/seed/', import.meta.url));

/** Collections the seed script owns. Reset re-seeds them; it never empties them blindly. */
export const SEED_COLLECTIONS = [
  COLLECTIONS.customers,
  COLLECTIONS.orders,
  COLLECTIONS.tickets,
  COLLECTIONS.policies,
] as const satisfies readonly CollectionName[];

/** Everything the pipeline writes during a run. Reset empties these. */
export const RUN_COLLECTIONS: readonly CollectionName[] = ALL_COLLECTIONS.filter(
  (name) => !(SEED_COLLECTIONS as readonly string[]).includes(name),
);

/** Required ticket split (PRD T2). Small tickets exclude the injection ticket. */
export const REQUIRED_SPLIT = Object.freeze({
  total: 12,
  small: 8,
  mid: 2,
  large: 1,
  injection: 1,
});

export interface ExpectedOutcome {
  ticket_id: string;
  expected_refund_cents: number;
  expected_tier: Tier;
  category: string;
  summary: string;
  /** Present on the prompt-injection ticket only. */
  injection?: { requested_cents: number; marker: string };
}

export interface ExpectedFile {
  policy_version: number;
  tickets: ExpectedOutcome[];
}

export interface SeedData {
  customers: CustomerDoc[];
  orders: OrderDoc[];
  tickets: TicketDoc[];
  expected: ExpectedFile;
}

export class SeedDataError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Seed data is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n  - ${problems.join('\n  - ')}`);
    this.name = 'SeedDataError';
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

function readEjsonFile(dir: string, file: string): unknown {
  const path = join(dir, file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SeedDataError([`cannot read ${path}: ${(err as Error).message}`]);
  }
  try {
    return EJSON.parse(text, { relaxed: true });
  } catch (err) {
    throw new SeedDataError([`${path} is not valid Extended JSON: ${(err as Error).message}`]);
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const isNonNegInt = (v: unknown): v is number => isInt(v) && v >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const isDate = (v: unknown): v is Date => v instanceof Date && !Number.isNaN(v.getTime());

/** Field-level shape checks, since JSON carries no types. Pushes into `problems`. */
function checkShapes(data: SeedData, problems: string[]): void {
  const where = (kind: string, doc: { _id?: unknown }, i: number) => `${kind}[${i}] ${String(doc?._id ?? '(no _id)')}`;

  data.customers.forEach((c, i) => {
    const w = where('customer', c, i);
    if (!isStr(c._id)) problems.push(`${w}: _id must be a non-empty string`);
    if (!isStr(c.name)) problems.push(`${w}: name must be a non-empty string`);
    if (!isStr(c.email) || !c.email.includes('@')) problems.push(`${w}: email must look like an email`);
    if (!isDate(c.created_at)) problems.push(`${w}: created_at must be a date`);
  });

  data.orders.forEach((o, i) => {
    const w = where('order', o, i);
    if (!isStr(o._id)) problems.push(`${w}: _id must be a non-empty string`);
    if (!isStr(o.customer_id)) problems.push(`${w}: customer_id must be a non-empty string`);
    if (!Array.isArray(o.items) || o.items.length === 0) {
      problems.push(`${w}: items must be a non-empty array`);
    } else {
      o.items.forEach((item, j) => {
        if (!isStr(item.sku) || !isStr(item.name)) problems.push(`${w}: items[${j}] needs sku and name`);
        if (!isInt(item.quantity) || item.quantity < 1) problems.push(`${w}: items[${j}].quantity must be a positive integer`);
        if (!isInt(item.unit_price_cents) || item.unit_price_cents < 1) {
          problems.push(`${w}: items[${j}].unit_price_cents must be a positive integer (cents)`);
        }
      });
    }
    if (!isInt(o.amount_cents) || o.amount_cents < 1) problems.push(`${w}: amount_cents must be a positive integer (cents)`);
    if (!isNonNegInt(o.refunded_cents)) problems.push(`${w}: refunded_cents must be a non-negative integer (cents)`);
    if (o.currency !== 'usd') problems.push(`${w}: currency must be "usd"`);
    if (!isStr(o.payment_id) || !o.payment_id.startsWith('pi_fake_')) {
      problems.push(`${w}: payment_id must be a fake ID starting with "pi_fake_" (real Stripe seeding is a later phase)`);
    }
    if (!['paid', 'partially_refunded', 'refunded'].includes(o.status)) problems.push(`${w}: invalid status ${String(o.status)}`);
    if (!isDate(o.created_at)) problems.push(`${w}: created_at must be a date`);
  });

  data.tickets.forEach((t, i) => {
    const w = where('ticket', t, i);
    for (const field of ['_id', 'customer_id', 'order_id', 'subject', 'body'] as const) {
      if (!isStr(t[field])) problems.push(`${w}: ${field} must be a non-empty string`);
    }
    if (t.status !== 'open') problems.push(`${w}: seeded tickets must have status "open"`);
    if (!isDate(t.created_at)) problems.push(`${w}: created_at must be a date`);
  });

  if (!data.expected || !Array.isArray(data.expected.tickets)) {
    problems.push('expected.json: must have a "tickets" array');
  }
}

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) (seen.has(id) ? dupes : seen).add(id);
  return [...dupes];
}

/** Refundable amount left on an order. */
export function refundableCents(order: Pick<OrderDoc, 'amount_cents' | 'refunded_cents'>): number {
  return order.amount_cents - order.refunded_cents;
}

/** Throws SeedDataError listing every problem found. Returns `data` unchanged when valid. */
export function validateSeedData(data: SeedData, policy: Policy = DEFAULT_POLICY): SeedData {
  const problems: string[] = [];
  checkShapes(data, problems);
  if (problems.length > 0) throw new SeedDataError(problems);

  for (const [kind, docs] of [
    ['customer', data.customers],
    ['order', data.orders],
    ['ticket', data.tickets],
  ] as const) {
    for (const id of findDuplicates(docs.map((d) => d._id))) problems.push(`duplicate ${kind} _id ${id}`);
  }
  for (const id of findDuplicates(data.orders.map((o) => o.payment_id))) problems.push(`duplicate payment_id ${id}`);

  const customers = new Map(data.customers.map((c) => [c._id, c]));
  const orders = new Map(data.orders.map((o) => [o._id, o]));

  for (const o of data.orders) {
    if (!customers.has(o.customer_id)) problems.push(`order ${o._id}: customer ${o.customer_id} does not exist`);
    const itemsTotal = o.items.reduce((sum, item) => sum + item.quantity * item.unit_price_cents, 0);
    if (itemsTotal !== o.amount_cents) {
      problems.push(`order ${o._id}: amount_cents ${o.amount_cents} does not equal the sum of its items ${itemsTotal}`);
    }
    if (o.refunded_cents > o.amount_cents) {
      problems.push(`order ${o._id}: refunded_cents ${o.refunded_cents} exceeds amount_cents ${o.amount_cents}`);
    }
    const expectedStatus =
      o.refunded_cents === 0 ? 'paid' : o.refunded_cents >= o.amount_cents ? 'refunded' : 'partially_refunded';
    if (o.status !== expectedStatus) {
      problems.push(`order ${o._id}: status "${o.status}" should be "${expectedStatus}" given refunded_cents`);
    }
  }

  for (const t of data.tickets) {
    if (!customers.has(t.customer_id)) problems.push(`ticket ${t._id}: customer ${t.customer_id} does not exist`);
    const order = orders.get(t.order_id);
    if (!order) {
      problems.push(`ticket ${t._id}: order ${t.order_id} does not exist`);
    } else {
      if (order.customer_id !== t.customer_id) {
        problems.push(`ticket ${t._id}: order ${t.order_id} belongs to ${order.customer_id}, not ${t.customer_id}`);
      }
      if (t.created_at < order.created_at) problems.push(`ticket ${t._id}: opened before its order was placed`);
    }
  }
  for (const id of findDuplicates(data.tickets.map((t) => t.order_id))) {
    problems.push(`order ${id} has more than one ticket (idempotency keys would collide)`);
  }

  // expected.json
  const tickets = new Map(data.tickets.map((t) => [t._id, t]));
  const expected = data.expected.tickets;
  for (const id of findDuplicates(expected.map((e) => e.ticket_id))) problems.push(`expected.json: duplicate entry for ${id}`);
  for (const t of data.tickets) {
    if (!expected.some((e) => e.ticket_id === t._id)) problems.push(`expected.json: no entry for ticket ${t._id}`);
  }

  let small = 0;
  let mid = 0;
  let large = 0;
  let injection = 0;
  for (const e of expected) {
    const ticket = tickets.get(e.ticket_id);
    if (!ticket) {
      problems.push(`expected.json: ticket ${e.ticket_id} does not exist`);
      continue;
    }
    if (!isInt(e.expected_refund_cents) || e.expected_refund_cents < 1) {
      problems.push(`expected.json ${e.ticket_id}: expected_refund_cents must be a positive integer (cents)`);
      continue;
    }
    const order = orders.get(ticket.order_id);
    if (order && e.expected_refund_cents > refundableCents(order)) {
      problems.push(
        `expected.json ${e.ticket_id}: refund ${e.expected_refund_cents} exceeds order ${order._id}'s refundable amount ${refundableCents(order)}`,
      );
    }
    const tier = tierFor(e.expected_refund_cents, policy);
    if (tier !== e.expected_tier) {
      problems.push(`expected.json ${e.ticket_id}: expected_tier "${e.expected_tier}" but ${e.expected_refund_cents} cents is "${tier}" under policy v${policy.version}`);
    }
    if (e.injection) {
      injection += 1;
      if (!ticket.body.includes(e.injection.marker)) {
        problems.push(`expected.json ${e.ticket_id}: injection marker not found in the ticket body`);
      }
      if (tier !== 'single_agent') problems.push(`expected.json ${e.ticket_id}: the injection ticket's legitimate refund must be small`);
      if (tierFor(e.injection.requested_cents, policy) !== 'blocked') {
        problems.push(`expected.json ${e.ticket_id}: the injected amount should be over the hard cap`);
      }
    } else if (tier === 'single_agent') small += 1;
    else if (tier === 'peer_review') mid += 1;
    else if (tier === 'human_required') large += 1;
    else problems.push(`expected.json ${e.ticket_id}: tier "${tier}" is not part of the demo`);
  }

  const split = { total: data.tickets.length, small, mid, large, injection };
  for (const key of Object.keys(REQUIRED_SPLIT) as (keyof typeof REQUIRED_SPLIT)[]) {
    if (split[key] !== REQUIRED_SPLIT[key]) {
      problems.push(`tier split: expected ${REQUIRED_SPLIT[key]} ${key} ticket(s), found ${split[key]}`);
    }
  }

  if (problems.length > 0) throw new SeedDataError(problems);
  return data;
}

/** Read data/seed (or `dir`) and validate it. Throws SeedDataError on any problem. */
export function loadSeedData(dir: string = SEED_DIR, policy: Policy = DEFAULT_POLICY): SeedData {
  const asArray = (file: string): unknown[] => {
    const value = readEjsonFile(dir, file);
    if (!Array.isArray(value)) throw new SeedDataError([`${file} must contain a JSON array`]);
    return value;
  };
  const data: SeedData = {
    customers: asArray('customers.json') as CustomerDoc[],
    orders: asArray('orders.json') as OrderDoc[],
    tickets: asArray('tickets.json') as TicketDoc[],
    expected: readEjsonFile(dir, 'expected.json') as ExpectedFile,
  };
  return validateSeedData(data, policy);
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

export interface CollectionSeedResult {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Documents in the collection that are not part of the dataset, deleted. */
  removed: number;
}

export interface SeedSummary {
  schema: ChangeSummary;
  customers: CollectionSeedResult;
  orders: CollectionSeedResult;
  tickets: CollectionSeedResult;
  policy: { version: number; created: boolean; updated: boolean; deactivated: number };
}

export interface SeedOptions {
  data?: SeedData;
  policy?: Policy;
}

/**
 * Upsert docs by `_id` with full replacement (so fields the pipeline changed,
 * like a ticket's status or an order's refunded_cents, go back to the seed
 * values), and delete anything in the collection that is not in the dataset.
 */
async function upsertExact<T extends { _id: string }>(db: Db, name: CollectionName, docs: T[]): Promise<CollectionSeedResult> {
  type SeedDoc = { _id: string } & Document;
  const coll = db.collection<SeedDoc>(name);
  const ops: AnyBulkWriteOperation<SeedDoc>[] = docs.map((doc) => ({
    replaceOne: { filter: { _id: doc._id }, replacement: doc as SeedDoc, upsert: true },
  }));
  const result = await coll.bulkWrite(ops, { ordered: false });
  const removed = await coll.deleteMany({ _id: { $nin: docs.map((d) => d._id) } });
  return {
    inserted: result.upsertedCount,
    updated: result.modifiedCount,
    unchanged: result.matchedCount - result.modifiedCount,
    removed: removed.deletedCount,
  };
}

/**
 * Apply the schema, then load the dataset and make `policy` the one active
 * policy document. Must run with an admin connection. Idempotent.
 */
export async function seedDatabase(db: Db, options: SeedOptions = {}): Promise<SeedSummary> {
  const policy = options.policy ?? DEFAULT_POLICY;
  const data = options.data ? validateSeedData(options.data, policy) : loadSeedData(SEED_DIR, policy);

  const schema = await applySchema(db, policy);

  const [customers, orders, tickets] = await Promise.all([
    upsertExact(db, COLLECTIONS.customers, data.customers),
    upsertExact(db, COLLECTIONS.orders, data.orders),
    upsertExact(db, COLLECTIONS.tickets, data.tickets),
  ]);

  // Policy `_id` is an ObjectId, so match on version and keep the first
  // created_at; a second run leaves the document byte-for-byte unchanged.
  const policies = db.collection<PolicyDoc>(COLLECTIONS.policies);
  const upsert = await policies.updateOne(
    { version: policy.version },
    {
      $set: {
        active: true,
        auto_cap_cents: policy.auto_cap_cents,
        single_approver_cap_cents: policy.single_approver_cap_cents,
        hard_cap_cents: policy.hard_cap_cents,
      },
      $setOnInsert: { created_at: new Date() },
    },
    { upsert: true },
  );
  const deactivated = await policies.updateMany(
    { version: { $ne: policy.version }, active: true },
    { $set: { active: false } },
  );

  return {
    schema,
    customers,
    orders,
    tickets,
    policy: {
      version: policy.version,
      created: upsert.upsertedCount > 0,
      updated: upsert.modifiedCount > 0,
      deactivated: deactivated.modifiedCount,
    },
  };
}

function formatCollection(name: string, r: CollectionSeedResult): string {
  const total = r.inserted + r.updated + r.unchanged;
  return `  ${name.padEnd(10)} ${String(total).padStart(3)} docs  (${r.inserted} inserted, ${r.updated} updated, ${r.unchanged} unchanged, ${r.removed} removed)`;
}

export function formatSeedSummary(summary: SeedSummary): string {
  const s = summary.schema;
  const p = summary.policy;
  return [
    `  schema     ${s.created.length} created, ${s.updated.length} updated, ${s.unchanged.length} unchanged`,
    formatCollection('customers', summary.customers),
    formatCollection('orders', summary.orders),
    formatCollection('tickets', summary.tickets),
    `  policy     v${p.version} active (${p.created ? 'created' : p.updated ? 'updated' : 'unchanged'}${p.deactivated ? `, ${p.deactivated} other version(s) deactivated` : ''})`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

export interface ResetSummary {
  cleared: Record<string, number>;
  seed: SeedSummary;
  durationMs: number;
}

/**
 * Empty every run collection with deleteMany (collections, validators,
 * indexes, roles and users stay), then re-seed. Never drops anything:
 * dropping would remove validators and invalidate Change Stream watchers.
 */
export async function resetDatabase(db: Db, options: SeedOptions = {}): Promise<ResetSummary> {
  const started = performance.now();
  // Validate before deleting anything, so a broken dataset leaves the database as it was.
  const data = options.data ?? loadSeedData(SEED_DIR, options.policy ?? DEFAULT_POLICY);
  const results = await Promise.all(
    RUN_COLLECTIONS.map(async (name) => [name, (await db.collection(name).deleteMany({})).deletedCount] as const),
  );
  const seed = await seedDatabase(db, { ...options, data });
  return { cleared: Object.fromEntries(results), seed, durationMs: performance.now() - started };
}

export function formatResetSummary(summary: ResetSummary): string {
  const cleared = Object.entries(summary.cleared)
    .map(([name, n]) => `${name}=${n}`)
    .join(', ');
  return [`  cleared    ${cleared}`, formatSeedSummary(summary.seed)].join('\n');
}
