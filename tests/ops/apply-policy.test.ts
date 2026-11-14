/** T5 and TEST_PLAN O3: raising the auto cap to $750. */
import { beforeEach, describe, expect, it } from 'vitest';
import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS, type IntentDoc } from '@escrowops/shared';
import { resolveTicket } from '@escrowops/agent';
import { useTestDb, captureServerError } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { resetDatabase, seedDatabase } from '../../scripts/lib/seed-data.js';
import { activePolicy, applyPolicy } from '../../scripts/lib/policy-admin.js';
import { proposeScript, scriptedModel } from '../agent/fake-model.js';

const t = useTestDb('apply_policy');
let seeded = false;

const intent = (amount_cents: number, policy_version: number, n: string): IntentDoc => ({
  _id: new ObjectId(),
  trace_id: `tr-${n}`,
  ticket_id: `T-POLICY-${n}`,
  order_id: 'O-5101',
  customer_id: 'C-1001',
  amount_cents,
  currency: 'usd',
  reason: 'Testing the policy cap with a realistic refund reason.',
  evidence: [{ kind: 'order', ref: 'O-5101' }],
  policy_version,
  idempotency_key: `k-${n}-${Math.random()}`,
  created_at: new Date(),
});

async function agentDb(): Promise<Db> {
  return (await t().connectAsRole('agent')).db(t().dbName);
}

beforeEach(async () => {
  if (!seeded) {
    await setUpAccess(t());
    await seedDatabase(t().db);
    seeded = true;
  } else {
    await resetDatabase(t().db);
  }
});

describe('apply-policy', () => {
  it('O3: a $750 auto cap accepts a $600 intent and rejects the old policy version', async () => {
    const agent = (await agentDb()).collection<IntentDoc>(COLLECTIONS.intents);
    expect((await captureServerError(() => agent.insertOne(intent(60_000, 1, 'a'))))?.code).toBe(121);

    const result = await applyPolicy(t().db, { auto_cap_cents: 75_000 });
    expect(result).toMatchObject({ newVersion: true, policy: { version: 2, auto_cap_cents: 75_000 } });
    expect(await activePolicy(t().db)).toMatchObject({ version: 2, auto_cap_cents: 75_000 });

    await agent.insertOne(intent(60_000, 2, 'b'));
    expect((await captureServerError(() => agent.insertOne(intent(4_200, 1, 'c'))))?.code).toBe(121);
    expect((await captureServerError(() => agent.insertOne(intent(75_001, 2, 'd'))))?.code).toBe(121);
  });

  it('the agent picks up the new version and tiers from the database', async () => {
    const { policy } = await applyPolicy(t().db, { auto_cap_cents: 150_000 });
    const db = await agentDb();
    // T-1009, not T-1010: one $689 chair is off-precedent (A7) and would be held whatever the cap.
    const r = await resolveTicket('T-1009', { db, model: 'm', createMessage: scriptedModel(proposeScript('T-1009', 'O-5109', 129_900)).createMessage });
    expect(r.status).toBe('proposed'); // $1,299 is now within the auto cap
    // Versions only go up, even after a reset re-activates v1.
    expect(await t().db.collection<IntentDoc>(COLLECTIONS.intents).findOne({ ticket_id: 'T-1009' })).toMatchObject({ policy_version: policy.version });
  });

  it('with no change it only re-applies the active validators; npm run reset restores the seed policy', async () => {
    const same = await applyPolicy(t().db);
    expect(same.newVersion).toBe(false);
    expect(same.policy.version).toBe(1);

    await applyPolicy(t().db, { auto_cap_cents: 75_000 });
    await resetDatabase(t().db);
    expect(await activePolicy(t().db)).toMatchObject({ version: 1, auto_cap_cents: 50_000 });
  });

  it('refuses caps that are not increasing, and changes nothing', async () => {
    await expect(applyPolicy(t().db, { auto_cap_cents: 300_000 })).rejects.toThrow(/caps must satisfy/);
    expect((await activePolicy(t().db)).version).toBe(1);
  });
});
