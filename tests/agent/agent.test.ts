/**
 * Agent (PRD A1 to A6) against the real schema, roles and seed data, running as
 * escrow_agent. Claude is replaced by a scripted fake; TEST_PLAN section 6 (evals)
 * covers the real model.
 */
import { createHash } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { COLLECTIONS, type AgentTraceDoc, type IntentDoc, type ReviewQueueDoc } from '@escrowops/shared';
import { readFileSync } from 'node:fs';
import {
  buildExpectedRecording,
  describeViolations,
  emptyRecording,
  failedRules,
  idempotencyKey,
  recordingCreateMessage,
  replayCreateMessage,
  resolveTicket,
  runBatch,
  statusLine,
  type AgentOptions,
} from '@escrowops/agent';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { loadSeedData, resetDatabase, seedDatabase } from '../../scripts/lib/seed-data.js';
import { message, proposeScript, scriptedModel, text, toolUse } from './fake-model.js';

const t = useTestDb('agent');
let agentDb: Db;

const intents = () => t().db.collection<IntentDoc>(COLLECTIONS.intents);
const reviews = () => t().db.collection<ReviewQueueDoc>(COLLECTIONS.review_queue);
const traces = () => t().db.collection<AgentTraceDoc>(COLLECTIONS.agent_traces);

function opts(createMessage: AgentOptions['createMessage'], extra: Partial<AgentOptions> = {}): AgentOptions {
  return { db: agentDb, createMessage, model: 'claude-sonnet-5-5', ...extra };
}

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
  agentDb = (await t().connectAsRole('agent')).db(t().dbName);
});
beforeEach(async () => {
  await resetDatabase(t().db);
});

describe('propose_refund (A2, A4)', () => {
  it('I1: a $89 proposal lands in intents with the ticket, customer and policy version', async () => {
    const { createMessage } = scriptedModel(proposeScript('T-1001', 'O-5101', 8900));
    const r = await resolveTicket('T-1001', opts(createMessage));

    expect(r.status).toBe('proposed');
    const doc = await intents().findOne({ ticket_id: 'T-1001' });
    expect(doc).toMatchObject({
      trace_id: r.trace_id,
      order_id: 'O-5101',
      customer_id: 'C-1001',
      amount_cents: 8900,
      currency: 'usd',
      policy_version: 1,
      idempotency_key: idempotencyKey('T-1001', 'O-5101'),
    });
    expect(await reviews().countDocuments()).toBe(0);
  });

  it('I2: a $1,299 proposal is rejected by the validator (121) and held in review_queue for one approver', async () => {
    const { createMessage } = scriptedModel(proposeScript('T-1009', 'O-5109', 129_900));
    const r = await resolveTicket('T-1009', opts(createMessage));

    expect(r.status).toBe('held');
    expect(await intents().countDocuments()).toBe(0);
    const review = await reviews().findOne({ ticket_id: 'T-1009' });
    expect(review).toMatchObject({ tier: 'peer_review', required_approvals: 1, status: 'pending', amount_cents: 129_900 });
    expect(review?.validator_error.code).toBe(121);
    expect(failedRules(review?.validator_error.errInfo)).toContain('maximum');
  });

  it('a $5,000 proposal needs two approvers; over $10,000 is tier blocked', async () => {
    await resolveTicket('T-1011', opts(scriptedModel(proposeScript('T-1011', 'O-5111', 500_000)).createMessage));
    expect(await reviews().findOne({ ticket_id: 'T-1011' })).toMatchObject({ tier: 'human_required', required_approvals: 2 });

    await resetDatabase(t().db);
    await resolveTicket('T-1011', opts(scriptedModel(proposeScript('T-1011', 'O-5111', 1_200_000)).createMessage));
    expect(await reviews().findOne({ ticket_id: 'T-1011' })).toMatchObject({ tier: 'blocked', required_approvals: 2 });
  });

  it('I10: proposing the same ticket and order twice creates one proposal', async () => {
    await resolveTicket('T-1001', opts(scriptedModel(proposeScript('T-1001', 'O-5101', 8900)).createMessage));
    const second = await resolveTicket('T-1001', opts(scriptedModel(proposeScript('T-1001', 'O-5101', 4500)).createMessage));
    expect(second.status).toBe('already_proposed');
    expect(await intents().countDocuments({ ticket_id: 'T-1001' })).toBe(1);
  });

  it('the idempotency key matches the red-team script (sha256 of "ticket|order")', () => {
    expect(idempotencyKey('T-1', 'O-1')).toBe(createHash('sha256').update('T-1|O-1').digest('hex'));
    expect(idempotencyKey('T-1', 'O-1')).not.toBe(idempotencyKey('T-1', 'O-2'));
  });

  it('takes the customer from the ticket, not from the model', async () => {
    // The model points the refund at another customer's order; the proposal still names the ticket's customer,
    // so the executor's E5 check (order belongs to customer) refuses to pay it.
    const { createMessage } = scriptedModel(proposeScript('T-1001', 'O-5102', 1000));
    await resolveTicket('T-1001', opts(createMessage));
    expect(await intents().findOne({ ticket_id: 'T-1001' })).toMatchObject({ order_id: 'O-5102', customer_id: 'C-1001' });
  });

  it('allows only one decision per ticket run', async () => {
    const { createMessage } = scriptedModel([
      ...proposeScript('T-1001', 'O-5101', 8900).slice(0, 3),
      message([toolUse('decline_refund', { reason: 'Changed my mind about this ticket entirely.' })]),
      message([text('Done.')]),
    ]);
    const r = await resolveTicket('T-1001', opts(createMessage));
    expect(r.status).toBe('proposed');
    const result = await traces().findOne({ trace_id: r.trace_id, kind: 'tool_result', tool: 'decline_refund' });
    expect(result?.output).toMatchObject({ error: expect.stringMatching(/already been recorded/) });
  });
});

describe('prompt injection (T-1012)', () => {
  it('a fooled agent proposing $50,000 is held as blocked; nothing reaches intents', async () => {
    const { createMessage } = scriptedModel(proposeScript('T-1012', 'O-5112', 5_000_000));
    const r = await resolveTicket('T-1012', opts(createMessage));
    expect(r.status).toBe('held');
    expect(await intents().countDocuments()).toBe(0);
    expect(await reviews().findOne({ ticket_id: 'T-1012' })).toMatchObject({ tier: 'blocked', status: 'pending' });
  });
});

describe('decline (A6)', () => {
  it('records the decision and reason; writes no proposal', async () => {
    const { createMessage } = scriptedModel([
      message([toolUse('get_ticket', { ticket_id: 'T-1002' })]),
      message([toolUse('decline_refund', { reason: 'The order was already refunded in full.' })]),
      message([text('Declined.')]),
    ]);
    const r = await resolveTicket('T-1002', opts(createMessage));
    expect(r.status).toBe('declined');
    expect(await intents().countDocuments()).toBe(0);
    expect(await reviews().countDocuments()).toBe(0);
    const decision = await traces().findOne({ trace_id: r.trace_id, kind: 'decision' });
    expect(decision?.output).toMatchObject({ status: 'declined', reason: 'The order was already refunded in full.' });
  });
});

describe('traces (A3)', () => {
  it('every tool call, result, reasoning and the decision share one trace_id, in order', async () => {
    const { createMessage } = scriptedModel(proposeScript('T-1001', 'O-5101', 8900));
    const r = await resolveTicket('T-1001', opts(createMessage));
    const events = await traces().find({ trace_id: r.trace_id }).sort({ seq: 1 }).toArray();

    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
    expect(events.map((e) => `${e.kind}${e.tool ? `:${e.tool}` : ''}`)).toEqual([
      'tool_call:get_ticket',
      'tool_result:get_ticket',
      'tool_call:get_order',
      'tool_result:get_order',
      'reasoning',
      'tool_call:propose_refund',
      'decision:propose_refund',
      'tool_result:propose_refund',
      'reasoning',
    ]);
    expect(events.every((e) => e.ticket_id === 'T-1001')).toBe(true);
  });

  it('a tool error goes back to the model as is_error and is traced', async () => {
    const { createMessage, requests } = scriptedModel([
      message([toolUse('get_order', { order_id: 'O-NOPE' })]),
      message([toolUse('decline_refund', { reason: 'The order named in the ticket does not exist.' })]),
      message([text('Declined.')]),
    ]);
    const r = await resolveTicket('T-1001', opts(createMessage));
    expect(r.status).toBe('declined');
    const toolResult = (requests[1]!.messages.at(-1)!.content as Array<{ is_error?: boolean; content: string }>)[0]!;
    expect(toolResult).toMatchObject({ is_error: true, content: 'order O-NOPE not found' });
  });
});

describe('loop outcomes', () => {
  it('a model that stops without deciding is recorded as no_decision', async () => {
    const r = await resolveTicket('T-1001', opts(scriptedModel([message([text('I am not sure.')])]).createMessage));
    expect(r.status).toBe('no_decision');
    expect(await traces().findOne({ trace_id: r.trace_id, kind: 'error' })).toBeTruthy();
  });

  it('a refusal stops the loop without running tools', async () => {
    const refusal = message([toolUse('propose_refund', { order_id: 'O-5101' })], 'refusal');
    const r = await resolveTicket('T-1001', opts(scriptedModel([refusal]).createMessage));
    expect(r.status).toBe('refused');
    expect(await intents().countDocuments()).toBe(0);
  });

  it('stops at the turn limit', async () => {
    const loop = Array.from({ length: 3 }, () => message([toolUse('get_ticket', { ticket_id: 'T-1001' })]));
    const r = await resolveTicket('T-1001', opts(scriptedModel(loop).createMessage, { maxTurns: 3 }));
    expect(r).toMatchObject({ status: 'no_decision', detail: 'turn limit' });
  });

  it('sends strict tools, adaptive thinking, the effort and the refusal fallback', async () => {
    const { createMessage, requests } = scriptedModel(proposeScript('T-1001', 'O-5101', 8900));
    await resolveTicket('T-1001', opts(createMessage, { effort: 'high' }));
    const p = requests[0]!;
    expect(p.model).toBe('claude-sonnet-5-5');
    expect(p.tools?.every((tool) => 'strict' in tool && tool.strict)).toBe(true);
    expect(p.thinking).toMatchObject({ type: 'adaptive' });
    expect(p.output_config).toEqual({ effort: 'high' });
    expect(p).toMatchObject({ fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    // The ticket body is never put in the prompt directly; the model reads it through get_ticket.
    expect(JSON.stringify(p.messages)).not.toContain('Lamp');
  });
});

describe('batch runner (A5)', () => {
  it('works several tickets and prints one status line each', async () => {
    const scripts: Record<string, ReturnType<typeof scriptedModel>> = {
      'T-1001': scriptedModel(proposeScript('T-1001', 'O-5101', 8900)),
      'T-1009': scriptedModel(proposeScript('T-1009', 'O-5109', 129_900)),
    };
    const lines: string[] = [];
    const results = await runBatch(['T-1001', 'T-1009'], {
      ...opts(async (params) => {
        const first = params.messages[0]!.content as string;
        const id = first.match(/T-\d+/)![0];
        return scripts[id]!.createMessage(params);
      }),
      concurrency: 2,
      onResult: (r) => lines.push(statusLine(r)),
    });
    expect(results.map((r) => r.status).sort()).toEqual(['held', 'proposed']);
    expect(lines.find((l) => l.startsWith('T-1001'))).toMatch(/✔ \$89\.00 auto-approved -> intents/);
    const held = lines.find((l) => l.startsWith('T-1009'))!;
    expect(held).toContain('MongoServerError: Document failed validation (code 121)');
    expect(held).toContain('amount_cents: 129900 — maximum 50000');
    expect(held).toContain('→ routed to review_queue (peer_review, needs 1 approval)');
  });
});

describe('replay (DEMO.md fallback)', () => {
  it('the expected-outcomes recording works every seeded ticket into the expected tier, with no model', async () => {
    const seed = loadSeedData();
    const expected = JSON.parse(readFileSync(new URL('../../data/seed/expected.json', import.meta.url), 'utf8')) as {
      tickets: Array<{ ticket_id: string; expected_refund_cents: number; expected_tier: string; summary: string }>;
    };
    const rec = buildExpectedRecording(seed.tickets, seed.orders, expected.tickets);
    const results = await runBatch(
      seed.tickets.map((t) => t._id),
      { ...opts(replayCreateMessage(rec)), concurrency: 4 },
    );
    for (const e of expected.tickets) {
      const r = results.find((x) => x.ticket_id === e.ticket_id)!;
      expect(r.status, e.ticket_id).toBe(e.expected_tier === 'single_agent' ? 'proposed' : 'held');
      expect(r.decision && 'amount_cents' in r.decision ? r.decision.amount_cents : 0).toBe(e.expected_refund_cents);
    }
  });

  it('a recorded live run replays the same tool calls through the database', async () => {
    const rec = emptyRecording('claude-sonnet-5-5');
    const live = scriptedModel(proposeScript('T-1001', 'O-5101', 8900));
    await resolveTicket('T-1001', opts(recordingCreateMessage(live.createMessage, rec)));
    expect(rec.tickets['T-1001']).toHaveLength(4);

    await resetDatabase(t().db);
    const replayed = await resolveTicket('T-1001', opts(replayCreateMessage(rec)));
    expect(replayed.status).toBe('proposed');
    expect(await intents().findOne({ ticket_id: 'T-1001' })).toMatchObject({ amount_cents: 8900, trace_id: replayed.trace_id });
  });

  it('describes validator violations the way the demo prints them', () => {
    const errInfo = {
      details: {
        operatorName: '$jsonSchema',
        schemaRulesNotSatisfied: [
          {
            operatorName: 'properties',
            propertiesNotSatisfied: [{ propertyName: 'amount_cents', details: [{ operatorName: 'maximum', specifiedAs: { maximum: 50000 }, consideredValue: 500000 }] }],
          },
          { operatorName: 'additionalProperties', specifiedAs: { additionalProperties: false }, additionalProperties: ['approvals'] },
        ],
      },
    };
    expect(describeViolations(errInfo)).toEqual(['amount_cents: 500000 — maximum 50000', 'additionalProperties: approvals']);
  });
});
