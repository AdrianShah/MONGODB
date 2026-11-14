/**
 * Document builders and assertion helpers for the validator tests (TEST_PLAN
 * section 1). Not a test file itself.
 */
import { randomBytes } from 'node:crypto';
import { ObjectId, type Document, type MongoServerError } from 'mongodb';
import { expect } from 'vitest';
import { DEFAULT_POLICY, type Policy } from '@escrowops/shared';
import { ERROR_CODES, captureServerError, validatorOperatorNames } from '../helpers/index.js';

let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}-${randomBytes(4).toString('hex')}`;
}

/** A valid intent under `policy` (default $42.00). Every call gets a fresh `idempotency_key`. */
export function validIntent(overrides: Document = {}, policy: Policy = DEFAULT_POLICY): Document {
  return {
    _id: new ObjectId(),
    trace_id: unique('trace'),
    ticket_id: 'T-1001',
    order_id: 'O-2001',
    customer_id: 'C-3001',
    amount_cents: 4_200,
    currency: 'usd',
    reason: 'Item arrived damaged; photo evidence attached by the customer.',
    evidence: [{ kind: 'order', ref: 'O-2001' }],
    policy_version: policy.version,
    idempotency_key: unique('idem'),
    created_at: new Date(),
    ...overrides,
  };
}

/** A valid-shaped `approved` document with one approval entry per approver ID given. */
export function approvedDoc(
  amountCents: number,
  approverIds: readonly string[],
  overrides: Document = {},
  policy: Policy = DEFAULT_POLICY,
): Document {
  return {
    ...validIntent({ amount_cents: amountCents }, policy),
    review_id: new ObjectId(),
    approvals: approverIds.map((approver_id) => ({ approver_id, approved_at: new Date() })),
    ...overrides,
  };
}

/** Copy of `doc` without `key`. */
export function without(doc: Document, key: string): Document {
  const copy = { ...doc };
  delete copy[key];
  return copy;
}

export interface ExpectedRule {
  /** `operatorName` that must appear in `errInfo.details`, e.g. "maximum", "$expr", "$or". */
  rule: string;
  /** If set, the rule must appear under this `propertyName` node. */
  property?: string;
  /** If set, the top-level `$and` must list this clause index as not satisfied. */
  clause?: number;
}

/** Every node in the tree whose `propertyName` equals `name`. */
function findPropertyNodes(node: unknown, name: string, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    node.forEach((n) => findPropertyNodes(n, name, out));
  } else if (node && typeof node === 'object') {
    if ((node as Document)['propertyName'] === name) out.push(node);
    Object.values(node).forEach((v) => findPropertyNodes(v, name, out));
  }
  return out;
}

/** Every node in an `errInfo` tree whose `operatorName` equals `name`. */
export function findOperatorNodes(node: unknown, name: string, out: Document[] = []): Document[] {
  if (Array.isArray(node)) {
    node.forEach((n) => findOperatorNodes(n, name, out));
  } else if (node && typeof node === 'object') {
    if ((node as Document)['operatorName'] === name) out.push(node as Document);
    Object.values(node).forEach((v) => findOperatorNodes(v, name, out));
  }
  return out;
}

/** Assert that a code-121 error names the expected rule, walking the details tree. */
export function expectRule(err: MongoServerError, expected: ExpectedRule): void {
  expect(err.code).toBe(ERROR_CODES.DOCUMENT_VALIDATION_FAILURE);
  const errInfo = err.errInfo as Document | undefined;
  expect(errInfo?.['details'], 'errInfo.details present').toBeDefined();
  const details = errInfo!['details'] as Document;

  expect(validatorOperatorNames(details)).toContain(expected.rule);

  if (expected.property !== undefined) {
    const nodes = findPropertyNodes(details, expected.property);
    expect(nodes.length, `details name property ${expected.property}`).toBeGreaterThan(0);
    expect(validatorOperatorNames(nodes), `rule ${expected.rule} under ${expected.property}`).toContain(expected.rule);
  }

  if (expected.clause !== undefined) {
    expect(details['operatorName']).toBe('$and');
    const indexes = (details['clausesNotSatisfied'] as Document[]).map((c) => c['index'] as number);
    expect(indexes).toContain(expected.clause);
  }
}

/** Run a write expected to fail validation; assert 121 and the rule. */
export async function expectRejected(fn: () => Promise<unknown>, expected: ExpectedRule): Promise<MongoServerError> {
  const err = await captureServerError(fn);
  expectRule(err, expected);
  return err;
}

/** Clause indexes of the `approved` validator's top-level `$and`. */
export const APPROVED_CLAUSE = { schema: 0, distinct: 1, secondApprover: 2 } as const;
