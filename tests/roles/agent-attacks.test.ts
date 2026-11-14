/**
 * TEST_PLAN section 2, agent red-team set R1 to R10. Each attack runs as the
 * real agent user, from the same list `npm run redteam` uses.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { BSON, type Document, type ObjectId } from 'mongodb';
import { COLLECTIONS } from '@escrowops/shared';
import { useTestDb } from '../helpers/index.js';
import { AGENT_ATTACKS, buildIntent, newAttackContext, runAttack, type AttackContext } from '../../scripts/lib/redteam-attacks.js';
import { setUpAccess } from './role-helpers.js';

const t = useTestDb('roles_agent');

let ctx: AttackContext;
let intentsOptionsBefore: string;
let targetIntentId: ObjectId;
let targetTraceId: ObjectId;

async function intentsOptions(): Promise<string> {
  const [info] = await t().db.listCollections({ name: COLLECTIONS.intents }).toArray();
  return BSON.EJSON.stringify(((info as Document | undefined)?.['options'] ?? {}) as Document);
}

beforeAll(async () => {
  await setUpAccess(t());
  const agent = (await t().connectAsRole('agent')).db(t().dbName);

  // Legitimate agent writes that the attacks then try to tamper with.
  const intent = buildIntent({ amount_cents: 4_200, trace_id: 'trace-legit', ticket_id: 'T-1', order_id: 'O-1' });
  await agent.collection(COLLECTIONS.intents).insertOne(intent);
  targetIntentId = intent._id;
  const trace = await agent
    .collection(COLLECTIONS.agent_traces)
    .insertOne({ trace_id: 'trace-legit', ticket_id: 'T-1', seq: 0, kind: 'reasoning', text: 'ok', created_at: new Date() });
  targetTraceId = trace.insertedId;

  intentsOptionsBefore = await intentsOptions();
  ctx = newAttackContext(agent, { targetIntentId, targetTraceId });
});

describe('agent red-team set (connected as escrow_agent)', () => {
  for (const attack of AGENT_ATTACKS) {
    it(`${attack.id}: ${attack.name} is refused with ${attack.expectedCode}`, async () => {
      const result = await runAttack(attack, ctx);
      expect(result.denied, `${attack.id} was accepted by the server`).toBe(true);
      expect(result.code).toBe(attack.expectedCode);
    });
  }
});

// Runs after the attack describe block (tests in a file run in order).
describe('after the whole agent set', () => {
  it('approved and ledger are empty', async () => {
    expect(await t().db.collection(COLLECTIONS.approved).countDocuments()).toBe(0);
    expect(await t().db.collection(COLLECTIONS.ledger).countDocuments()).toBe(0);
  });

  it('the intents validator is unchanged', async () => {
    expect(await intentsOptions()).toBe(intentsOptionsBefore);
  });

  it('the earlier intent and trace are untouched', async () => {
    const intent = await t().db.collection(COLLECTIONS.intents).findOne({ _id: targetIntentId });
    expect(intent?.['amount_cents']).toBe(4_200);
    expect(await t().db.collection(COLLECTIONS.agent_traces).countDocuments({ _id: targetTraceId })).toBe(1);
  });

  it('no oversized or bypassed intent landed', async () => {
    expect(await t().db.collection(COLLECTIONS.intents).countDocuments({ amount_cents: { $gt: 50_000 } })).toBe(0);
  });
});
