/**
 * Agent -> MongoDB -> executor on the real seed data, each as its own database user.
 * Small refunds pay out once; held refunds never reach the provider.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '@escrowops/shared';
import { resolveTicket } from '@escrowops/agent';
import { Executor, FakeProvider, type ExecutorLedgerDoc } from '@escrowops/executor';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { seedDatabase } from '../../scripts/lib/seed-data.js';
import { proposeScript, scriptedModel } from '../agent/fake-model.js';
import { waitFor } from '../executor/fixtures.js';

const t = useTestDb('agent_payout');
const provider = new FakeProvider();
let executor: Executor;

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
  executor = new Executor({
    db: (await t().connectAsRole('executor')).db(t().dbName),
    provider,
    log: () => {},
    staleReconcileEveryMs: 0,
  });
  await executor.start();
});
afterAll(async () => {
  await executor?.stop();
});

describe('agent proposals reach the executor', () => {
  it('a $89 auto refund is paid once against the seeded order; a $1,299 held refund is not paid', async () => {
    const agentDb = (await t().connectAsRole('agent')).db(t().dbName);
    const run = (ticket: string, order: string, cents: number) =>
      resolveTicket(ticket, { db: agentDb, model: 'claude-sonnet-5-5', createMessage: scriptedModel(proposeScript(ticket, order, cents)).createMessage });

    const small = await run('T-1001', 'O-5101', 8900);
    const large = await run('T-1009', 'O-5109', 129_900);
    expect([small.status, large.status]).toEqual(['proposed', 'held']);

    const ledger = t().db.collection<ExecutorLedgerDoc>(COLLECTIONS.ledger);
    const entry = await waitFor(() => ledger.findOne({ ticket_id: 'T-1001', status: 'succeeded' }), { what: 'T-1001 payout' });
    expect(entry).toMatchObject({ trace_id: small.trace_id, amount_cents: 8900, source_collection: 'intents' });
    expect(provider.created).toHaveLength(1);
    expect(provider.created[0]!.request.paymentRef).toMatch(/^pi_/);

    await executor.idle();
    expect(await ledger.countDocuments({ ticket_id: 'T-1009' })).toBe(0);
  });
});
