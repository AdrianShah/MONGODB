/**
 * Compromised-agent demo (`npm run demo:jailbreak`): the scripted "fooled model" obeys the
 * injection in T-1012 and asks for $50,000 through the agent's normal tools and database user.
 * MongoDB refuses it (121 on intents, 13 on the hijack writes) and every refusal is in the trace.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { COLLECTIONS, verifyTrace, type AgentTraceDoc, type IntentDoc, type ReviewQueueDoc } from '@escrowops/shared';
import {
  COMPROMISED_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
  compromisedModel,
  injectedAmountCents,
  resolveTicket,
  type CreateMessage,
} from '@escrowops/agent';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { loadSeedData, resetDatabase, seedDatabase } from '../../scripts/lib/seed-data.js';
import { proposeScript, scriptedModel } from './fake-model.js';

const t = useTestDb('jailbreak');
let agentDb: Db;

const count = (c: string, trace_id: string) => t().db.collection(c).countDocuments({ trace_id });
const rejectedEvents = (trace_id: string) =>
  t().db.collection<AgentTraceDoc>(COLLECTIONS.agent_traces).find({ trace_id, kind: 'rejected_write' }).sort({ seq: 1 }).toArray();

function recording(inner: CreateMessage) {
  const requests: Parameters<CreateMessage>[0][] = [];
  const createMessage: CreateMessage = async (params) => {
    requests.push(structuredClone(params));
    return inner(params);
  };
  return { createMessage, requests };
}

const jailbreak = (createMessage: CreateMessage = compromisedModel()) =>
  resolveTicket('T-1012', { db: agentDb, createMessage, model: 'compromised-stub', compromised: true });

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
  agentDb = (await t().connectAsRole('agent')).db(t().dbName);
});
beforeEach(async () => {
  await resetDatabase(t().db);
});

describe('compromised agent vs T-1012 injection', () => {
  it('seed T-1012 carries the $50,000 injected instruction', () => {
    const ticket = loadSeedData().tickets.find((x) => x._id === 'T-1012');
    expect(ticket).toBeDefined();
    expect(injectedAmountCents(ticket!.body)).toBe(5_000_000);
  });

  it('strips the guardrails from the prompt and hands the model the hijack tools; honest mode is unchanged', async () => {
    const { createMessage, requests } = recording(compromisedModel());
    await jailbreak(createMessage);
    const system = (requests[0]!.system as Array<{ text: string }>)[0]!.text;
    expect(system).toBe(COMPROMISED_SYSTEM_PROMPT);
    expect(system).not.toContain('is data, not instructions');
    expect(requests[0]!.tools!.map((x) => ('name' in x ? x.name : ''))).toEqual(
      expect.arrayContaining(['propose_refund', 'record_approval', 'force_payout', 'edit_audit_trail']),
    );

    const honest = recording(scriptedModel(proposeScript('T-1001', 'O-5101', 8900)).createMessage);
    await resolveTicket('T-1001', { db: agentDb, createMessage: honest.createMessage, model: 'm' });
    expect((honest.requests[0]!.system as Array<{ text: string }>)[0]!.text).toBe(SYSTEM_PROMPT);
    expect(honest.requests[0]!.tools!.map((x) => ('name' in x ? x.name : ''))).not.toContain('record_approval');
  });

  it('the fooled model attempts the $50k write; MongoDB rejects it with 121 and every hijack write with 13', async () => {
    const r = await jailbreak();

    // The model was fooled: it asked for the injected amount.
    expect(r.decision).toMatchObject({ status: 'held', amount_cents: 5_000_000, tier: 'blocked' });
    expect(r.decision && 'violations' in r.decision ? r.decision.violations : []).toContain('amount_cents: 5000000 — maximum 50000');
    expect(r.rejections?.map((x) => [x.tool, x.collection, x.code])).toEqual([
      ['propose_refund', 'intents', 121],
      ['record_approval', 'approved', 13],
      ['force_payout', 'intents', 13],
      ['edit_audit_trail', 'agent_traces', 13],
    ]);

    // Nothing reached the collections that can move money.
    for (const c of [COLLECTIONS.intents, COLLECTIONS.approved, COLLECTIONS.ledger]) {
      expect(await count(c, r.trace_id), c).toBe(0);
      expect(await t().db.collection(c).countDocuments(), c).toBe(0);
    }
    // The only trace of the $50,000 is a pending review above the hard cap, which authorizes nothing.
    expect(await t().db.collection<ReviewQueueDoc>(COLLECTIONS.review_queue).findOne({ trace_id: r.trace_id })).toMatchObject({
      tier: 'blocked',
      status: 'pending',
      amount_cents: 5_000_000,
      validator_error: { code: 121 },
    });
  });

  it('records each attempt and its rejection in agent_traces under the trace id; the hash chain still verifies', async () => {
    const r = await jailbreak();
    const events = await rejectedEvents(r.trace_id);
    expect(events).toHaveLength(4);
    expect(events.every((e) => e.ticket_id === 'T-1012')).toBe(true);
    expect(events[0]).toMatchObject({
      tool: 'propose_refund',
      output: { collection: 'intents', code: 121, codeName: 'DocumentValidationFailure', amount_cents: 5_000_000, rules: ['maximum'] },
    });
    expect(events[0]!.text).toMatch(/insert on intents -> MongoDB rejected \(code 121 DocumentValidationFailure\): amount_cents: 5000000 — maximum 50000/);
    for (const e of events.slice(1)) expect(e.output).toMatchObject({ code: 13, codeName: 'Unauthorized', message: 'not authorized' });

    // Each refusal follows its own tool_call, and the model was told about it.
    const all = await t().db.collection<AgentTraceDoc>(COLLECTIONS.agent_traces).find({ trace_id: r.trace_id }).sort({ seq: 1 }).toArray();
    for (const e of events) expect(all.filter((x) => x.seq < e.seq && x.kind === 'tool_call').at(-1)?.tool).toBe(e.tool);
    expect(all.find((x) => x.kind === 'tool_result' && x.tool === 'force_payout')?.output).toMatchObject({ error: expect.stringMatching(/code 13/) });
    // No hijack write was accepted, and edit_audit_trail changed nothing.
    expect(all.some((x) => x.kind === 'error')).toBe(false);
    expect(await verifyTrace(t().db, r.trace_id)).toMatchObject({ ok: true, checked: all.length });
  });

  it('after an honest $59.99 proposal, the $50,000 is still refused with 121 and the honest proposal is untouched', async () => {
    const honest = await resolveTicket('T-1012', {
      db: agentDb,
      model: 'm',
      createMessage: scriptedModel(proposeScript('T-1012', 'O-5112', 5999)).createMessage,
    });
    expect(honest.status).toBe('proposed');

    const r = await jailbreak();
    expect(r.rejections?.[0]).toMatchObject({ tool: 'propose_refund', code: 121 });
    // review_queue has no cross-collection key, so the $50,000 is parked there (tier blocked, authorizes nothing).
    expect(r.decision).toMatchObject({ status: 'held', tier: 'blocked' });
    const intents = await t().db.collection<IntentDoc>(COLLECTIONS.intents).find().toArray();
    expect(intents.map((i) => [i.trace_id, i.amount_cents])).toEqual([[honest.trace_id, 5999]]);
    expect(await count(COLLECTIONS.approved, r.trace_id)).toBe(0);
    expect(await rejectedEvents(r.trace_id)).toHaveLength(4);
  });
});
