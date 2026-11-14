/**
 * Collections, validators and indexes.
 *
 * OWNER: Wave 1 Agent A (schema). Wave 0 ships a working `applySchema` with
 * empty `buildValidators` / `INDEXES` stubs so Agents B and C are never
 * blocked on it.
 *
 * Contract (keep these signatures stable):
 *
 *   buildValidators(policy: Policy): ValidatorMap
 *     Pure. Returns collection name -> full validator document (what goes in
 *     `collMod.validator`, e.g. `{ $jsonSchema: {...} }` or `{ $and: [...] }`).
 *     Collections without an entry get no validator from applySchema.
 *
 *   INDEXES: readonly IndexDefinition[]
 *     Every index the app relies on. `options.name` is required so
 *     applySchema can compare by name and stay idempotent.
 *
 *   applySchema(db: Db, policy?: Policy): Promise<ChangeSummary>
 *     Idempotent. Must be run with an admin connection. For every name in
 *     COLLECTIONS: creates the collection if missing; applies its validator
 *     via `collMod` with validationLevel "strict" and validationAction
 *     "error" when the stored one differs; creates every index in INDEXES
 *     (an existing index with the same name but a different definition is
 *     dropped and recreated). A collection that has a validator on the
 *     server but none in the map is left as it is.
 *     Returns what it did, entries like "collection:intents",
 *     "validator:intents", "index:intents.idempotency_key_unique".
 *     A second run on an unchanged database returns created = updated = [].
 */
// `EJSON` is not a named ESM export of 'mongodb' under plain Node/tsx (it is
// under Vitest), so always reach it through `BSON.EJSON`.
import { BSON, type CreateIndexesOptions, type Db, type Document } from 'mongodb';

const { EJSON } = BSON;
import { ALL_COLLECTIONS, type CollectionName } from './collections.js';
import { DEFAULT_POLICY, assertValidPolicy, type Policy } from './policy.js';
import { emptyChangeSummary, type ChangeSummary } from './types.js';

export type ValidatorMap = Partial<Record<CollectionName, Document>>;

export interface IndexDefinition {
  collection: CollectionName;
  key: Record<string, 1 | -1>;
  options: CreateIndexesOptions & { name: string };
}

export const VALIDATION_LEVEL = 'strict' as const;
export const VALIDATION_ACTION = 'error' as const;

/** Fields every refund proposal carries (intents, and the core of approved). */
const PROPOSAL_REQUIRED = [
  '_id',
  'trace_id',
  'ticket_id',
  'order_id',
  'customer_id',
  'amount_cents',
  'currency',
  'reason',
  'evidence',
  'policy_version',
  'idempotency_key',
  'created_at',
] as const;

/** `$jsonSchema.properties` for the proposal fields, with the amount ceiling and version from the policy. */
function proposalProperties(maxAmountCents: number, policyVersion: number): Document {
  return {
    _id: { bsonType: 'objectId' },
    trace_id: { bsonType: 'string' },
    ticket_id: { bsonType: 'string' },
    order_id: { bsonType: 'string' },
    customer_id: { bsonType: 'string' },
    amount_cents: { bsonType: ['int', 'long'], minimum: 1, maximum: maxAmountCents },
    currency: { enum: ['usd'] },
    reason: { bsonType: 'string', minLength: 20, maxLength: 2000 },
    evidence: { bsonType: 'array', minItems: 1, items: { bsonType: 'object' } },
    policy_version: { enum: [policyVersion] },
    idempotency_key: { bsonType: 'string' },
    created_at: { bsonType: 'date' },
  };
}

/**
 * Policy -> validators (PRD section 7). Pure; every threshold and the
 * accepted `policy_version` come from `policy`.
 *
 * - intents: `$jsonSchema` only, amount capped at `auto_cap_cents`.
 * - approved: explicit `$and` of [`$jsonSchema`, distinct-approvers `$expr`,
 *   second-approver `$or`]. In a 121 the failing clause is under
 *   `details.clausesNotSatisfied[i]`, index 0, 1, 2 in that order.
 * - budgets: `$expr` spent <= cap.
 */
export function buildValidators(policy: Policy): ValidatorMap {
  assertValidPolicy(policy);

  const intents: Document = {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: [...PROPOSAL_REQUIRED],
      properties: proposalProperties(policy.auto_cap_cents, policy.version),
    },
  };

  const approved: Document = {
    $and: [
      {
        $jsonSchema: {
          bsonType: 'object',
          additionalProperties: false,
          required: [...PROPOSAL_REQUIRED, 'review_id', 'approvals'],
          properties: {
            ...proposalProperties(policy.hard_cap_cents, policy.version),
            review_id: { bsonType: 'objectId' },
            approvals: {
              bsonType: 'array',
              minItems: 1,
              items: {
                bsonType: 'object',
                required: ['approver_id', 'approved_at'],
                properties: {
                  approver_id: { bsonType: 'string' },
                  approved_at: { bsonType: 'date' },
                },
              },
            },
          },
        },
      },
      // Approvers are distinct. If `approvals` is missing or not an array,
      // `$size` errors; the server still reports 121, listing this clause
      // next to the $jsonSchema one (verified on 8.0).
      {
        $expr: {
          $eq: [{ $size: '$approvals.approver_id' }, { $size: { $setUnion: ['$approvals.approver_id', []] } }],
        },
      },
      // Over the single-approver cap needs a second approver.
      {
        $or: [{ amount_cents: { $lte: policy.single_approver_cap_cents } }, { 'approvals.1': { $exists: true } }],
      },
    ],
  };

  const budgets: Document = { $expr: { $lte: ['$spent_cents', '$cap_cents'] } };

  return { intents, approved, budgets };
}

/** Every index the app relies on (PRD section 7, "Unique indexes"). */
export const INDEXES: readonly IndexDefinition[] = Object.freeze<IndexDefinition[]>([
  {
    collection: 'intents',
    key: { idempotency_key: 1 },
    options: { name: 'idempotency_key_unique', unique: true },
  },
  {
    collection: 'review_queue',
    key: { idempotency_key: 1 },
    options: { name: 'idempotency_key_unique', unique: true },
  },
  {
    collection: 'approvals',
    key: { review_id: 1, approver_id: 1 },
    options: { name: 'review_id_approver_id_unique', unique: true },
  },
  {
    collection: 'approved',
    key: { review_id: 1 },
    options: { name: 'review_id_unique', unique: true },
  },
  {
    collection: 'ledger',
    key: { source_id: 1 },
    options: { name: 'source_id_unique', unique: true },
  },
]);

function sameDocument(a: unknown, b: unknown): boolean {
  return EJSON.stringify(a as Document) === EJSON.stringify(b as Document);
}

/** Options that decide whether an existing index matches a definition. */
function indexSignature(key: unknown, options: Document): string {
  return EJSON.stringify({
    key,
    unique: options['unique'] === true,
    sparse: options['sparse'] === true,
    partialFilterExpression: options['partialFilterExpression'] ?? null,
    expireAfterSeconds: options['expireAfterSeconds'] ?? null,
  });
}

export async function applySchema(db: Db, policy: Policy = DEFAULT_POLICY): Promise<ChangeSummary> {
  const summary = emptyChangeSummary();
  const validators = buildValidators(policy);

  const existing = new Map<string, Document>();
  for (const info of await db.listCollections({}, { nameOnly: false }).toArray()) {
    existing.set(info.name, (info as Document)['options'] ?? {});
  }

  for (const name of ALL_COLLECTIONS) {
    const validator = validators[name];
    const tag = `collection:${name}`;
    if (!existing.has(name)) {
      await db.createCollection(
        name,
        validator
          ? { validator, validationLevel: VALIDATION_LEVEL, validationAction: VALIDATION_ACTION }
          : {},
      );
      summary.created.push(tag);
      if (validator) summary.created.push(`validator:${name}`);
      continue;
    }
    summary.unchanged.push(tag);
    if (!validator) continue;

    const options = existing.get(name) ?? {};
    const upToDate =
      sameDocument(options['validator'], validator) &&
      options['validationLevel'] === VALIDATION_LEVEL &&
      options['validationAction'] === VALIDATION_ACTION;
    if (upToDate) {
      summary.unchanged.push(`validator:${name}`);
    } else {
      await db.command({
        collMod: name,
        validator,
        validationLevel: VALIDATION_LEVEL,
        validationAction: VALIDATION_ACTION,
      });
      (options['validator'] ? summary.updated : summary.created).push(`validator:${name}`);
    }
  }

  for (const index of INDEXES) {
    const tag = `index:${index.collection}.${index.options.name}`;
    const collection = db.collection(index.collection);
    const current = (await collection.listIndexes().toArray()).find((i) => i['name'] === index.options.name);
    if (current) {
      if (indexSignature(current['key'], current) === indexSignature(index.key, index.options)) {
        summary.unchanged.push(tag);
        continue;
      }
      await collection.dropIndex(index.options.name);
      await collection.createIndex(index.key, index.options);
      summary.updated.push(tag);
    } else {
      await collection.createIndex(index.key, index.options);
      summary.created.push(tag);
    }
  }

  return summary;
}
