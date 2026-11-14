/**
 * A7: the precedent-deviation guard and the citations it persists.
 *
 * Rule (precedent.ts): the ceiling is 2x the largest refund among the 3 most similar refunded
 * precedents. Above it, a proposal is held for one human even under the $500 auto cap. The
 * in-memory server has no $vectorSearch, so search falls back to the same cosine ranking.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import {
  COLLECTIONS,
  ceilingFrom,
  embeddingConfig,
  precedentDeviation,
  type ApprovedDoc,
  type IntentDoc,
  type PrecedentHit,
  type ReviewQueueDoc,
} from '@escrowops/shared';
import { resolveTicket } from '@escrowops/agent';
import { ReviewService } from '@escrowops/api';
import { ERROR_CODES, expectServerError, useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { seedDatabase } from '../../scripts/lib/seed-data.js';
import { message, scriptedModel, text, toolUse } from './fake-model.js';

const t = useTestDb('precedent_guard');
let agentDb: Db;

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
  agentDb = (await t().connectAsRole('agent')).db(t().dbName);
});

const hit = (id: string, refund_cents: number, outcome: PrecedentHit['outcome'] = 'refunded', score = 0.9): PrecedentHit => ({
  precedent_id: id,
  category: 'c',
  summary: 's',
  rationale: 'r',
  outcome,
  refund_cents,
  score,
});

/** T-1001 (lamp, order O-5101): propose `amount_cents`, citing precedent P-001. */
function lampScript(amount_cents: number) {
  return scriptedModel([
    message([toolUse('get_ticket', { ticket_id: 'T-1001' })]),
    message([toolUse('search_precedents', { query: 'lamp arrived broken, refund the lamp only' })]),
    message([
      toolUse('propose_refund', {
        order_id: 'O-5101',
        amount_cents,
        reason: 'The lamp arrived shattered; precedent P-001 refunds the damaged line item only.',
        evidence: [
          { kind: 'order_line', ref: 'O-5101', note: 'Lamp line item.' },
          { kind: 'precedent', ref: 'P-001', note: 'Damaged item refunded at its order price.' },
        ],
      }),
    ]),
    message([text('Done.')]),
  ]).createMessage;
}

describe('ceiling rule (pure)', () => {
  it('is 2x the largest of the 3 closest refunded precedents; declined ones are skipped', () => {
    const check = ceilingFrom([hit('A', 0, 'declined'), hit('B', 2_000), hit('C', 6_400, 'partial'), hit('D', 1_500), hit('E', 99_999)], 'test');
    expect(check.basis.map((b) => b.precedent_id)).toEqual(['B', 'C', 'D']);
    expect(check.ceiling_cents).toBe(12_800);
    expect(precedentDeviation(12_800, check)).toBeUndefined();
    expect(precedentDeviation(12_801, check)).toMatch(/^precedent_deviation: \$128\.01 is more than 2x the largest refund \(\$64\.00, C\)/);
  });

  it('does not apply without a comparable precedent', () => {
    const check = ceilingFrom([hit('A', 0, 'declined')], 'test');
    expect(check.ceiling_cents).toBeNull();
    expect(precedentDeviation(1_000_000, check)).toBeUndefined();
  });
});

describe('embedding config', () => {
  it('uses Voyage only with a key, and the index dimension follows the model', () => {
    expect(embeddingConfig({})).toMatchObject({ provider: 'local', dimensions: 256 });
    expect(embeddingConfig({ VOYAGE_API_KEY: 'k' })).toMatchObject({ provider: 'voyage', model: 'voyage-3.5', dimensions: 1024 });
    expect(embeddingConfig({ VOYAGE_API_KEY: 'k', VOYAGE_DIMENSIONS: '512', VOYAGE_MODEL: 'voyage-3-large' })).toMatchObject({
      model: 'voyage-3-large',
      dimensions: 512,
    });
    expect(embeddingConfig({ VOYAGE_API_KEY: 'k', EMBEDDING_PROVIDER: 'local' }).provider).toBe('local');
  });
});

describe('agent with the precedent guard', () => {
  it('an on-precedent refund is auto-approved, with the precedent check and citations persisted on the intent', async () => {
    const r = await resolveTicket('T-1001', { db: agentDb, model: 'm', createMessage: lampScript(8_900) });
    expect(r.status).toBe('proposed');
    const intent = await t().db.collection<IntentDoc>(COLLECTIONS.intents).findOne({ ticket_id: 'T-1001' });
    expect(intent?.precedent_check).toMatchObject({ multiplier: 2, method: expect.stringMatching(/^local_cosine:local-hash-256$/) });
    expect(intent!.precedent_check!.basis).toHaveLength(3);
    for (const b of intent!.precedent_check!.basis) {
      expect(b.precedent_id).toMatch(/^P-\d{3}$/);
      expect(b.score).toBeGreaterThan(0);
    }
    expect(intent!.amount_cents).toBeLessThanOrEqual(intent!.precedent_check!.ceiling_cents!);
    expect(intent?.precedents_cited).toEqual([
      expect.objectContaining({ precedent_id: 'P-001', refund_cents: 6_400, outcome: 'refunded', score: expect.any(Number) }),
    ]);
  });

  it('an off-precedent refund under the auto cap is held for one human, with the reason recorded', async () => {
    await t().db.collection(COLLECTIONS.intents).deleteMany({ ticket_id: 'T-1001' });
    // $400 is under the $500 auto cap, but far above what similar lamp/damage cases paid.
    const r = await resolveTicket('T-1001', { db: agentDb, model: 'm', createMessage: lampScript(40_000) });
    expect(r.status).toBe('held');
    expect(await t().db.collection(COLLECTIONS.intents).countDocuments({ ticket_id: 'T-1001' })).toBe(0);

    const review = await t().db.collection<ReviewQueueDoc>(COLLECTIONS.review_queue).findOne({ ticket_id: 'T-1001' });
    expect(review).toMatchObject({ tier: 'peer_review', required_approvals: 1, status: 'pending', amount_cents: 40_000 });
    expect(review!.validator_error?.code).toBe(121); // the intents validator's $expr refused it
    expect(review!.hold_reasons?.[0]).toMatch(/^precedent_deviation: \$400\.00 is more than 2x/);
    expect(review!.precedent_check!.ceiling_cents).toBeLessThan(40_000);
    expect(review!.precedents_cited?.[0]?.precedent_id).toBe('P-001');

    // The review card shows why, and approval carries the citations into `approved`.
    const reviews = new ReviewService(t().admin, t().db);
    const card = await reviews.get(review!._id);
    expect(card.rules_broken).toContain('precedent_deviation');
    expect(card.hold_reasons?.[0]).toMatch(/^precedent_deviation/);
    expect(card.precedent_check?.basis).toHaveLength(3);
    expect(card.precedents_cited?.[0]?.precedent_id).toBe('P-001');

    const { outcome } = await reviews.approve(review!._id, 'alice');
    expect(outcome).toBe('promoted');
    const approved = await t().db.collection<ApprovedDoc>(COLLECTIONS.approved).findOne({ review_id: review!._id });
    expect(approved?.precedent_check?.ceiling_cents).toBe(review!.precedent_check!.ceiling_cents);
    expect(approved?.precedents_cited?.[0]?.precedent_id).toBe('P-001');
  });

  it('the intents validator refuses an amount above its recorded precedent ceiling', async () => {
    const agentIntents = agentDb.collection<IntentDoc>(COLLECTIONS.intents);
    await expectServerError(
      () =>
        agentIntents.insertOne({
          _id: new ObjectId(),
          trace_id: 'tr_validator',
          ticket_id: 'T-1003',
          order_id: 'O-5103',
          customer_id: 'C-1003',
          amount_cents: 10_000,
          currency: 'usd',
          reason: 'Testing the precedent ceiling in the validator.',
          evidence: [{ kind: 'order', ref: 'O-5103' }],
          policy_version: 1,
          idempotency_key: 'precedent-ceiling-test',
          created_at: new Date(),
          precedent_check: { ceiling_cents: 4_800, multiplier: 2, basis: [{ precedent_id: 'P-004', score: 0.9, refund_cents: 1_500, outcome: 'refunded' }], method: 'test' },
        }),
      ERROR_CODES.DOCUMENT_VALIDATION_FAILURE,
    );
  });
});
