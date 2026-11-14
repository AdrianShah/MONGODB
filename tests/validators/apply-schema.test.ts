/**
 * applySchema idempotency, policy-derived thresholds, and TEST_PLAN O3
 * (raising the auto cap to $750 under policy version 2).
 *
 * Each describe block works in its own collections' state, so the blocks run
 * sequentially against one database in the order written.
 */
import { BSON, type Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import {
  ALL_COLLECTIONS,
  COLLECTIONS,
  DEFAULT_POLICY,
  INDEXES,
  applySchema,
  assertValidPolicy,
  buildValidators,
  tierFor,
  type Policy,
} from '@escrowops/shared';
import { useTestDb } from '../helpers/index.js';
import { APPROVED_CLAUSE, approvedDoc, expectRejected, validIntent } from './fixtures.js';

const t = useTestDb('validators');

const intents = () => t().db.collection(COLLECTIONS.intents);
const approved = () => t().db.collection(COLLECTIONS.approved);

describe('buildValidators (pure)', () => {
  it('builds validators for exactly intents, approved and budgets', () => {
    expect(Object.keys(buildValidators(DEFAULT_POLICY)).sort()).toEqual(['approved', 'budgets', 'intents']);
  });

  it('derives every threshold and the version from the policy', () => {
    const policy: Policy = { version: 7, auto_cap_cents: 1_111, single_approver_cap_cents: 2_222, hard_cap_cents: 3_333 };
    const v = buildValidators(policy);
    const intent = v.intents!['$jsonSchema'] as Document;
    expect(intent['properties'].amount_cents.maximum).toBe(1_111);
    expect(intent['properties'].policy_version).toEqual({ enum: [7] });
    const [schema, , or] = v.approved!['$and'] as Document[];
    expect(schema!['$jsonSchema'].properties.amount_cents.maximum).toBe(3_333);
    expect(schema!['$jsonSchema'].properties.policy_version).toEqual({ enum: [7] });
    expect(or).toEqual({ $or: [{ amount_cents: { $lte: 2_222 } }, { 'approvals.1': { $exists: true } }] });
    // No default threshold leaks into a non-default policy.
    const text = BSON.EJSON.stringify(v);
    for (const n of [50_000, 200_000, 1_000_000]) expect(text).not.toContain(String(n));
  });

  it('lists _id wherever additionalProperties is false', () => {
    const v = buildValidators(DEFAULT_POLICY);
    const schemas = [v.intents!['$jsonSchema'], (v.approved!['$and'] as Document[])[0]!['$jsonSchema']] as Document[];
    for (const s of schemas) {
      expect(s['additionalProperties']).toBe(false);
      expect(s['properties']).toHaveProperty('_id');
      expect(s['required']).toContain('_id');
    }
  });

  it('rejects an inconsistent policy', () => {
    expect(() => buildValidators({ ...DEFAULT_POLICY, auto_cap_cents: 300_000 })).toThrow(/caps must satisfy/);
    expect(() => assertValidPolicy({ ...DEFAULT_POLICY, version: 0 })).toThrow(/version/);
    expect(() => assertValidPolicy({ ...DEFAULT_POLICY, hard_cap_cents: 1.5e6 + 0.5 })).toThrow(/hard_cap_cents/);
  });

  it('tierFor matches the PRD section 5 table at each boundary', () => {
    expect(tierFor(50_000)).toBe('single_agent');
    expect(tierFor(50_001)).toBe('peer_review');
    expect(tierFor(200_000)).toBe('peer_review');
    expect(tierFor(200_001)).toBe('human_required');
    expect(tierFor(1_000_000)).toBe('human_required');
    expect(tierFor(1_000_001)).toBe('blocked');
  });
});

describe('applySchema', () => {
  it('first run creates every collection, the three validators and five indexes', async () => {
    const summary = await applySchema(t().db);
    expect(summary.updated).toEqual([]);
    for (const name of ALL_COLLECTIONS) expect(summary.created).toContain(`collection:${name}`);
    for (const name of ['intents', 'approved', 'budgets']) expect(summary.created).toContain(`validator:${name}`);
    for (const i of INDEXES) expect(summary.created).toContain(`index:${i.collection}.${i.options.name}`);

    const infos = await t().db.listCollections({}, { nameOnly: false }).toArray();
    const withValidator = infos.filter((i) => (i as Document)['options']?.validator).map((i) => i.name).sort();
    expect(withValidator).toEqual(['approved', 'budgets', 'intents']);
    for (const info of infos.filter((i) => withValidator.includes(i.name))) {
      const options = (info as Document)['options'];
      expect(options.validationLevel).toBe('strict');
      expect(options.validationAction).toBe('error');
    }
  });

  it('second and third runs make no changes', async () => {
    for (let run = 0; run < 2; run += 1) {
      const summary = await applySchema(t().db);
      expect(summary.created).toEqual([]);
      expect(summary.updated).toEqual([]);
    }
  });
});

describe('O3 apply-policy raising the auto cap to $750 (version 2)', () => {
  const V2: Policy = { ...DEFAULT_POLICY, version: 2, auto_cap_cents: 75_000 };

  it('O3 before: a $600 intent is rejected under version 1', async () => {
    await expectRejected(() => intents().insertOne(validIntent({ amount_cents: 60_000 })), {
      rule: 'maximum',
      property: 'amount_cents',
    });
  });

  it('O3 applying version 2 updates the intents and approved validators only', async () => {
    const summary = await applySchema(t().db, V2);
    expect(summary.created).toEqual([]);
    expect(summary.updated.sort()).toEqual(['validator:approved', 'validator:intents']);
    const again = await applySchema(t().db, V2);
    expect([...again.created, ...again.updated]).toEqual([]);
  });

  it('O3 after: a $600 intent with policy_version 2 is accepted', async () => {
    const doc = validIntent({ amount_cents: 60_000 }, V2);
    expect((await intents().insertOne(doc)).insertedId).toEqual(doc['_id']);
  });

  it('O3 after: the same intent carrying policy_version 1 is rejected', async () => {
    await expectRejected(() => intents().insertOne(validIntent({ amount_cents: 60_000, policy_version: 1 })), {
      rule: 'enum',
      property: 'policy_version',
    });
  });

  it('O3 boundary: $750.00 accepted, $750.01 rejected', async () => {
    await intents().insertOne(validIntent({ amount_cents: 75_000 }, V2));
    await expectRejected(() => intents().insertOne(validIntent({ amount_cents: 75_001 }, V2)), {
      rule: 'maximum',
      property: 'amount_cents',
    });
  });

  it('O3 approved also requires the new version', async () => {
    await approved().insertOne(approvedDoc(150_000, ['alice'], {}, V2));
    await expectRejected(() => approved().insertOne(approvedDoc(150_000, ['alice'], { policy_version: 1 }, V2)), {
      rule: 'enum',
      property: 'policy_version',
      clause: APPROVED_CLAUSE.schema,
    });
  });
});

describe('custom policy boundaries reach the server', () => {
  const P: Policy = { version: 3, auto_cap_cents: 1_000, single_approver_cap_cents: 5_000, hard_cap_cents: 20_000 };

  it('B-custom applies and enforces every threshold', async () => {
    await applySchema(t().db, P);

    await intents().insertOne(validIntent({ amount_cents: 1_000 }, P));
    await expectRejected(() => intents().insertOne(validIntent({ amount_cents: 1_001 }, P)), { rule: 'maximum', property: 'amount_cents' });

    await approved().insertOne(approvedDoc(5_000, ['alice'], {}, P));
    await expectRejected(() => approved().insertOne(approvedDoc(5_001, ['alice'], {}, P)), {
      rule: '$or',
      clause: APPROVED_CLAUSE.secondApprover,
    });
    await approved().insertOne(approvedDoc(20_000, ['alice', 'bob'], {}, P));
    await expectRejected(() => approved().insertOne(approvedDoc(20_001, ['alice', 'bob'], {}, P)), {
      rule: 'maximum',
      property: 'amount_cents',
      clause: APPROVED_CLAUSE.schema,
    });
  });

  it('B-custom restoring the default policy updates the validators back', async () => {
    const summary = await applySchema(t().db, DEFAULT_POLICY);
    expect(summary.updated.sort()).toEqual(['validator:approved', 'validator:intents']);
    await intents().insertOne(validIntent({ amount_cents: 50_000 }));
  });
});
