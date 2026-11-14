/**
 * Compromised-agent demo (`npm run demo:jailbreak`): the scripted "fooled model" obeys the
 * injection in T-1012 and asks for $50,000 through the agent's normal tools and database user.
 * MongoDB refuses it (121 on intents, 13 on the hijack writes) and every refusal is in the trace.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { COLLECTIONS, type AgentTraceDoc } from '@escrowops/shared';
import { compromisedModel, injectedAmountCents, resolveTicket } from '@escrowops/agent';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { loadSeedData, seedDatabase } from '../../scripts/lib/seed-data.js';

const t = useTestDb('jailbreak');
let agentDb: Db;

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
  agentDb = (await t().connectAsRole('agent')).db(t().dbName);
});

describe('compromised agent vs T-1012 injection', () => {
  it('seed T-1012 carries the $50,000 injected instruction', () => {
    const ticket = loadSeedData().tickets.find((x) => x._id === 'T-1012');
    expect(ticket).toBeDefined();
    expect(injectedAmountCents(ticket!.body)).toBe(5_000_000);
  });

  it('the fooled model attempts the $50k write; MongoDB rejects it with 121 and the audit trail records it', async () => {
    const r = await resolveTicket('T-1012', { db: agentDb, createMessage: compromisedModel(), model: 'compromised-stub', compromised: true });

    // The model was fooled: it asked for the injected amount.
    expect(r.decision && 'amount_cents' in r.decision ? r.decision.amount_cents : undefined).toBe(5_000_000);

    const rejections = r.rejections ?? [];
    const first = rejections[0];
    expect(first).toMatchObject({ tool: 'propose_refund', collection: COLLECTIONS.intents, code: 121, amount_cents: 5_000_000 });
    expect(first?.violations?.length).toBeGreaterThan(0);
    // The hijack follow-ups are refused by role privileges.
    expect(rejections.slice(1).map((x) => [x.tool, x.code])).toEqual([
      ['record_approval', 13],
      ['force_payout', 13],
      ['edit_audit_trail', 13],
    ]);

    // Nothing landed.
    const byTrace = { trace_id: r.trace_id };
    for (const c of [COLLECTIONS.intents, COLLECTIONS.approved, COLLECTIONS.ledger]) {
      expect(await t().db.collection(c).countDocuments(byTrace)).toBe(0);
    }

    // Audit record: attempted action + rejection, with identity (trace/ticket) and reason.
    const audit = await t()
      .db.collection<AgentTraceDoc>(COLLECTIONS.agent_traces)
      .find({ ...byTrace, kind: 'rejected_write' })
      .sort({ seq: 1 })
      .toArray();
    expect(audit).toHaveLength(4);
    expect(audit[0]).toMatchObject({ ticket_id: 'T-1012', tool: 'propose_refund', output: { code: 121, amount_cents: 5_000_000 } });
    expect(audit[0]?.text).toMatch(/code 121/);
    expect(
      await t().db.collection(COLLECTIONS.agent_traces).countDocuments({ ...byTrace, kind: 'error', text: /^GUARDRAIL FAILURE/ }),
    ).toBe(0);
  });
});
