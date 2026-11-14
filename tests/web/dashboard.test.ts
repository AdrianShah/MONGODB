/**
 * Dashboard server (S6, S7) on the full stack: agent (scripted model) -> executor and
 * approval service -> dashboard, each as its own database user. Includes TEST_PLAN I16.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { compromisedModel, resolveTicket } from '@escrowops/agent';
import type { PipelineMessage, TicketCard, TimelineEvent } from '@escrowops/web';
import { testServerUri } from '../helpers/index.js';
import { startStack, type Stack } from '../helpers/stack.js';
import { message, proposeScript, scriptedModel, text, toolUse } from '../agent/fake-model.js';
import { waitFor } from '../executor/fixtures.js';

let s: Stack;
let viewer: string; // a signed-in approver's session cookie; viewing needs one

const get = async <T>(path: string) => (await fetch(`${s.dashboardUrl}${path}`, { headers: { cookie: viewer } })).json() as Promise<T>;
const pipeline = async () => (await get<{ tickets: TicketCard[] }>('/api/pipeline')).tickets;
const ticket = async (id: string) => (await pipeline()).find((t) => t.ticket_id === id)!;
const agent = (id: string, turns: Parameters<typeof scriptedModel>[0]) =>
  resolveTicket(id, { db: s.agentDb, model: 'claude-sonnet-5-5', createMessage: scriptedModel(turns).createMessage });

async function loginViaDashboard(approver: string): Promise<string> {
  const res = await fetch(`${s.dashboardUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approver_id: approver, password: `${approver}-dev-password` }),
  });
  expect(res.status).toBe(200);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
const approve = (cookie: string, reviewId: string) =>
  fetch(`${s.dashboardUrl}/api/reviews/${reviewId}/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });

beforeAll(async () => {
  s = await startStack(testServerUri(), { prefix: 'dashboard', dailyBudgetCents: 500_000 });
  viewer = await loginViaDashboard('approver-b');
});
afterAll(async () => {
  await s?.stop();
});

describe('access', () => {
  it('pipeline, timeline and live feed need an approver session', async () => {
    expect((await fetch(`${s.dashboardUrl}/api/config`)).status).toBe(200);
    expect((await fetch(`${s.dashboardUrl}/api/pipeline`)).status).toBe(401);
    expect((await fetch(`${s.dashboardUrl}/api/timeline/x`)).status).toBe(401);
    expect((await fetch(`${s.dashboardUrl}/api/pipeline`, { headers: { cookie: 'escrowops_session=forged' } })).status).toBe(401);
    const anonymous = new WebSocket(`${s.dashboardUrl.replace('http', 'ws')}/ws/pipeline`);
    await expect(new Promise((ok, fail) => { anonymous.on('open', ok); anonymous.on('error', fail); })).rejects.toThrow(/401/);
    expect((await fetch(`${s.dashboardUrl}/api/pipeline`, { headers: { cookie: viewer } })).status).toBe(200);
  });
});

describe('pipeline (S6)', () => {
  it('starts with every seeded ticket open', async () => {
    const tickets = await pipeline();
    expect(tickets).toHaveLength(12);
    expect(new Set(tickets.map((t) => t.stage))).toEqual(new Set(['open']));
  });

  it('moves tickets through auto-approved to paid, held, and declined', async () => {
    await agent('T-1001', proposeScript('T-1001', 'O-5101', 8900));
    await agent('T-1009', proposeScript('T-1009', 'O-5109', 129_900));
    await agent('T-1002', [
      message([toolUse('get_ticket', { ticket_id: 'T-1002' })]),
      message([toolUse('decline_refund', { reason: 'Already refunded by the bank.' })]),
      message([text('Declined.')]),
    ]);

    const paid = await waitFor(async () => {
      const t = await ticket('T-1001');
      return t.stage === 'paid' ? t : undefined;
    }, { what: 'T-1001 paid' });
    expect(paid.ledger).toMatchObject({ status: 'succeeded', provider: 'fake', amount_cents: 8900 });
    // E6: the auto refund was reserved against today's budget.
    const { budget } = await get<{ budget: { spent_cents: number; cap_cents: number } }>('/api/pipeline');
    expect(budget).toMatchObject({ cap_cents: 500_000, spent_cents: 8900 });

    expect(await ticket('T-1009')).toMatchObject({
      stage: 'held',
      amount_cents: 129_900,
      review: { tier: 'peer_review', rules_broken: ['maximum'], approved_count: 0, required_approvals: 1 },
    });
    expect(await ticket('T-1002')).toMatchObject({ stage: 'declined', note: 'Already refunded by the bank.' });
  });

  it('pushes the pipeline over /ws/pipeline on connect and after every change', async () => {
    const ws = new WebSocket(`${s.dashboardUrl.replace('http', 'ws')}/ws/pipeline`, { headers: { cookie: viewer } });
    const msgs: PipelineMessage[] = [];
    ws.on('message', (raw) => msgs.push(JSON.parse(String(raw))));
    await waitFor(async () => msgs.length > 0, { what: 'initial pipeline' });

    const before = msgs.length;
    await agent('T-1003', proposeScript('T-1003', 'O-5103', 2495));
    const last = await waitFor(async () => {
      const m = msgs.slice(before).reverse().find((x) => x.tickets.find((t) => t.ticket_id === 'T-1003')?.stage === 'paid');
      return m;
    }, { what: 'T-1003 paid pushed' });
    expect(last.type).toBe('pipeline');
    ws.close();
  });
});

describe('approvals through the dashboard', () => {
  it('forwards login and approve to the approval service; the held refund is paid', async () => {
    const review = (await ticket('T-1009')).review!;
    const cookie = await loginViaDashboard('approver-a');
    expect(await (await fetch(`${s.dashboardUrl}/api/me`, { headers: { cookie } })).json()).toEqual({ approver_id: 'approver-a' });

    const res = await approve(cookie, review.id);
    expect(res.status).toBe(200);
    await waitFor(async () => (await ticket('T-1009')).stage === 'paid', { what: 'T-1009 paid' });
  });

  it('refuses an anonymous approve with 401', async () => {
    await agent('T-1010', proposeScript('T-1010', 'O-5110', 68_900));
    const review = (await ticket('T-1010')).review!;
    expect((await approve('', review.id)).status).toBe(401);
    expect((await ticket('T-1010')).stage).toBe('held');
  });
});

describe('audit timeline (S7)', () => {
  it('I16: one aggregation shows every step of a $5,000 refund, in order, ending with the refund ID', async () => {
    const run = await agent('T-1011', proposeScript('T-1011', 'O-5111', 500_000));
    const reviewId = (await ticket('T-1011')).review!.id;
    await approve(await loginViaDashboard('approver-a'), reviewId);
    await approve(await loginViaDashboard('approver-b'), reviewId);
    await waitFor(async () => (await ticket('T-1011')).stage === 'paid', { what: 'T-1011 paid' });

    const { events, integrity } = await get<{ events: TimelineEvent[]; integrity: { ok: boolean; checked: number } }>(
      `/api/timeline/${run.trace_id}`,
    );
    // S9: the agent's trace and both approvals verify as an unbroken hash chain.
    expect(integrity.ok).toBe(true);
    expect(integrity.checked).toBeGreaterThanOrEqual(8);
    const steps = events.map((e) => `${e.source}:${e.kind}`);
    const order = [
      'agent_traces:tool_call',
      'review_queue:held',
      'agent_traces:decision',
      'approvals:approve',
      'approved:promoted',
      'ledger:pending',
      'ledger:succeeded',
    ];
    let at = -1;
    for (const step of order) {
      const i = steps.indexOf(step, at + 1);
      expect(i, `${step} after position ${at} in ${steps.join(' > ')}`).toBeGreaterThan(at);
      at = i;
    }
    expect(steps.filter((x) => x === 'approvals:approve')).toHaveLength(2);
    expect(events.at(-1)!.summary).toMatch(/^Paid: fake refund re_fake_/);
    expect(events.find((e) => e.kind === 'held')!.summary).toMatch(/broke maximum/);
    // Times never go backwards.
    expect(events.map((e) => e.at)).toEqual([...events.map((e) => e.at)].sort());
  });
});

describe('compromised agent (npm run demo:jailbreak)', () => {
  it('the card is badged "Injection attempt blocked" and the timeline shows each refusal; nothing pays', async () => {
    const run = await resolveTicket('T-1012', { db: s.agentDb, model: 'compromised-stub', createMessage: compromisedModel(), compromised: true });

    const card = await waitFor(async () => {
      const c = await ticket('T-1012');
      return c.trace_id === run.trace_id ? c : undefined;
    }, { what: 'T-1012 jailbreak run on the pipeline' });
    expect(card.amount_cents).toBe(5_000_000);
    expect(card.blocked_writes?.map((b) => [b.tool, b.code])).toEqual([
      ['propose_refund', 121],
      ['record_approval', 13],
      ['force_payout', 13],
      ['edit_audit_trail', 13],
    ]);
    expect(card.review).toMatchObject({ tier: 'blocked' });
    expect(card.ledger).toBeUndefined();

    const { events } = await get<{ events: TimelineEvent[] }>(`/api/timeline/${run.trace_id}`);
    const refused = events.filter((e) => e.kind === 'rejected_write').map((e) => e.summary);
    expect(refused).toHaveLength(4);
    expect(refused[0]).toMatch(/^Agent tried propose_refund \$50000\.00 \(insert on intents\) → MongoDB rejected \(code 121 DocumentValidationFailure\): amount_cents: 5000000 — maximum 50000/);
    expect(refused[1]).toMatch(/record_approval .*approved\) → MongoDB rejected \(code 13 Unauthorized\)/);
    expect(events.some((e) => ['intents', 'approved', 'ledger'].includes(e.source))).toBe(false);
  });
});
