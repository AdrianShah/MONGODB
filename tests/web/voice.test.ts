/**
 * Voice for approvers: "Listen" on review cards and "Narrate audit trail" on the timeline.
 * The ElevenLabs HTTP call is mocked. Covers script text, auth, the no-key fallback, the
 * cache, that the key never reaches the browser, and that voice cannot approve.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveTicket } from '@escrowops/agent';
import type { ReviewCard } from '@escrowops/api/card';
import {
  buildDashboardServer,
  reviewScript,
  Speaker,
  spokenDollars,
  timelineScript,
  voiceOptionsFromEnv,
  DEFAULT_VOICE_ID,
  type TicketCard,
  type TimelineEvent,
} from '@escrowops/web';
import { testServerUri } from '../helpers/index.js';
import { startStack, type Stack } from '../helpers/stack.js';
import { proposeScript, scriptedModel } from '../agent/fake-model.js';
import { waitFor } from '../executor/fixtures.js';

const KEY = 'sk_test_elevenlabs_SECRET_do_not_leak_1234';
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 1, 2, 3]);

function fakeElevenLabs(status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    status === 200
      ? new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
      : new Response(JSON.stringify({ detail: { message: `invalid key ${KEY}` } }), { status }),
  );
}

const card: ReviewCard = {
  id: '65f000000000000000000001',
  trace_id: 'tr-1',
  ticket_id: 'T-1011',
  order_id: 'O-5111',
  customer_id: 'C-1',
  amount_cents: 500_000,
  tier: 'human_required',
  status: 'pending',
  reason: 'Refunding the affected line item at its order price.',
  evidence: [{ kind: 'order_line', ref: 'O-5111', note: 'Line item price from the order.' }],
  rules_broken: ['maximum'],
  required_approvals: 2,
  approvals: [{ approver_id: 'approver-a', decision: 'approve', at: '2026-11-14T10:00:00.000Z' }],
  approved_count: 1,
  created_at: '2026-11-14T09:59:00.000Z',
};

describe('scripts (deterministic templates)', () => {
  it('speaks amounts in words', () => {
    expect(spokenDollars(500_000)).toBe('5,000 dollars');
    expect(spokenDollars(129_950)).toBe('1,299 dollars and 50 cents');
    expect(spokenDollars(100)).toBe('1 dollar');
    expect(spokenDollars(undefined)).toBe('an unknown amount');
  });

  it('reads the review card: amount, tier, reason, evidence, rule broken and "1 of 2"', () => {
    const text = reviewScript(card);
    expect(text).toBe(
      'Review for ticket T-1011. The agent proposes a refund of 5,000 dollars on order O-5111. ' +
        'Tier: dual control, two different approvers required. Approval progress: 1 of 2, approved by approver-a. ' +
        "The agent's reason: Refunding the affected line item at its order price. " +
        'Evidence: order line, O-5111, Line item price from the order. ' +
        'MongoDB refused it as an auto refund. Validator rule broken: maximum. ' +
        'Listening approves nothing. To decide, use the Approve or Reject button.',
    );
    expect(reviewScript(card)).toBe(text); // deterministic
  });

  it('narrates the audit trail: ticket, tool calls, validator decision, approvers, payout ID', () => {
    const ev = (source: TimelineEvent['source'], kind: string, detail: Record<string, unknown> = {}): TimelineEvent => ({
      at: '2026-11-14T10:00:00.000Z',
      source,
      kind,
      summary: '',
      detail,
    });
    const text = timelineScript({
      ticket_id: 'T-1011',
      events: [
        ev('agent_traces', 'tool_call', { tool: 'get_ticket' }),
        ev('agent_traces', 'tool_result', { tool: 'get_ticket' }),
        ev('agent_traces', 'tool_call', { tool: 'get_order' }),
        ev('agent_traces', 'reasoning', { text: 'thinking' }),
        ev('agent_traces', 'tool_call', { tool: 'propose_refund' }),
        ev('review_queue', 'held', { amount_cents: 500_000, tier: 'human_required', rules_broken: ['maximum'] }),
        ev('agent_traces', 'decision', { output: { status: 'held', amount_cents: 500_000 } }),
        ev('approvals', 'approve', { approver_id: 'approver-a' }),
        ev('approvals', 'approve', { approver_id: 'approver-b' }),
        ev('review_queue', 'approved'),
        ev('approved', 'promoted', { approvers: ['approver-a', 'approver-b'] }),
        ev('ledger', 'pending', { amount_cents: 500_000, source_id: 'x' }),
        ev('ledger', 'succeeded', { provider: 'stripe', provider_refund_id: 're_123' }),
      ],
      integrity: { ok: true, checked: 9, problems: [] },
    });
    expect(text).toBe(
      'Audit trail for ticket T-1011. The agent made 3 tool calls: get ticket, get order and propose refund. ' +
        'The validator held 5,000 dollars for review, rule broken: maximum. Tier: dual control, two different approvers required. ' +
        'The agent proposed 5,000 dollars, and MongoDB refused it as an auto refund. ' +
        'approver-a approved. approver-b approved. Promoted to approved by approver-a and approver-b. ' +
        'The executor started the payout of 5,000 dollars. Paid. stripe refund ID re_123. ' +
        'Hash chain verified: 9 records unchanged since they were written.',
    );
  });
});

describe('Speaker (ElevenLabs client)', () => {
  it('calls the text-to-speech endpoint with the key in xi-api-key, once per text', async () => {
    const fetch = fakeElevenLabs();
    const speaker = new Speaker({ apiKey: KEY, voiceId: 'voice123', model: 'eleven_flash_v2_5', fetch });
    const a = await speaker.speak('hello');
    await speaker.speak('hello');
    expect(Buffer.compare(a, Buffer.from(MP3))).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/^https:\/\/api\.elevenlabs\.io\/v1\/text-to-speech\/voice123\?/);
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['xi-api-key']).toBe(KEY);
    expect(JSON.parse(String(init!.body))).toEqual({ text: 'hello', model_id: 'eleven_flash_v2_5' });
    await speaker.speak('hello, again');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not cache failures, and has no key means unavailable', async () => {
    const fetch = fakeElevenLabs(429);
    const speaker = new Speaker({ apiKey: KEY, fetch });
    await expect(speaker.speak('x')).rejects.toMatchObject({ status: 502, code: 'voice_failed' });
    await expect(speaker.speak('x')).rejects.toMatchObject({ code: 'voice_failed' });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(new Speaker({}).speak('x')).rejects.toMatchObject({ status: 503, code: 'voice_unavailable' });
  });

  it('reads its settings from the environment', () => {
    expect(voiceOptionsFromEnv({ ELEVENLABS_API_KEY: ' k ', ELEVENLABS_VOICE_ID: 'v' })).toEqual({ apiKey: 'k', voiceId: 'v' });
    expect(voiceOptionsFromEnv({ ELEVENLABS_API_KEY: '' })).toEqual({});
    expect(DEFAULT_VOICE_ID).toMatch(/^\w+$/);
  });
});

describe('voice routes on the dashboard', () => {
  let s: Stack;
  const eleven = fakeElevenLabs();
  let publicNoKeyUrl: string;
  let closePublic: () => Promise<unknown>;
  let cookieA: string;
  let cookieB: string;
  let reviewId: string;
  let traceId: string;
  /** Every body and header the browser got from a voice route, to check for the key. */
  const seen: string[] = [];

  const req = async (base: string, path: string, cookie = '', init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) } });
    const body = Buffer.from(await res.arrayBuffer());
    seen.push(JSON.stringify([...res.headers]), body.toString('latin1'));
    return { status: res.status, type: res.headers.get('content-type') ?? '', body, json: () => JSON.parse(body.toString()) };
  };
  const login = async (approver: string) => {
    const res = await fetch(`${s.dashboardUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approver_id: approver, password: `${approver}-dev-password` }),
    });
    return res.headers.get('set-cookie')!.split(';')[0]!;
  };
  const approve = (cookie: string) =>
    fetch(`${s.dashboardUrl}/api/reviews/${reviewId}/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  const ticket = async () =>
    ((await (await fetch(`${s.dashboardUrl}/api/pipeline`, { headers: { cookie: cookieA } })).json()) as { tickets: TicketCard[] }).tickets.find(
      (t) => t.ticket_id === 'T-1011',
    )!;

  beforeAll(async () => {
    s = await startStack(testServerUri(), { prefix: 'voice', voice: { apiKey: KEY, voiceId: 'voice123', fetch: eleven } });
    // A second dashboard on the same data: public viewing (DASHBOARD_PUBLIC=1) and no ElevenLabs key.
    const client = await s.t.connectAsRole('dashboard');
    const pub = await buildDashboardServer({ client, db: client.db(s.t.dbName), approvalUrl: s.approvalUrl, requireLogin: false, log: () => {} });
    await pub.listen({ port: 0, host: '127.0.0.1' });
    publicNoKeyUrl = `http://127.0.0.1:${(pub.server.address() as AddressInfo).port}`;
    closePublic = () => pub.close();

    const run = await resolveTicket('T-1011', {
      db: s.agentDb,
      model: 'claude-sonnet-5-5',
      createMessage: scriptedModel(proposeScript('T-1011', 'O-5111', 500_000)).createMessage,
    });
    traceId = run.trace_id;
    cookieA = await login('approver-a');
    cookieB = await login('approver-b');
    reviewId = (await waitFor(async () => (await ticket())?.review, { what: 'T-1011 held' })).id;
    expect((await approve(cookieA)).status).toBe(200);
  });
  afterAll(async () => {
    await closePublic?.();
    await s?.stop();
  });

  it('needs an approver session, even when the dashboard is public', async () => {
    for (const base of [s.dashboardUrl, publicNoKeyUrl]) {
      for (const path of [
        `/api/voice/review/${reviewId}`,
        `/api/voice/review/${reviewId}/audio`,
        `/api/voice/timeline/${traceId}`,
        `/api/voice/timeline/${traceId}/audio`,
      ]) {
        expect((await req(base, path)).status, `${base}${path}`).toBe(401);
        expect((await req(base, path, 'escrowops_session=forged')).status).toBe(401);
      }
      expect((await req(base, '/api/voice/config')).json()).toMatchObject({ approver: false });
    }
    expect(eleven).not.toHaveBeenCalled();
  });

  it('Listen: returns the card script and ElevenLabs audio, cached per card version', async () => {
    expect((await req(s.dashboardUrl, '/api/voice/config', cookieB)).json()).toEqual({ elevenlabs: true, approver: true });
    const script = (await req(s.dashboardUrl, `/api/voice/review/${reviewId}`, cookieB)).json() as { text: string; audio: string };
    expect(script.text).toContain('refund of 5,000 dollars on order O-5111');
    expect(script.text).toContain('Approval progress: 1 of 2, approved by approver-a');
    expect(script.text).toContain('Validator rule broken: maximum');
    expect(script.audio).toMatch(new RegExp(`^/api/voice/review/${reviewId}/audio\\?v=[0-9a-f]{16}$`));

    const audio = await req(s.dashboardUrl, script.audio, cookieB);
    expect(audio.status).toBe(200);
    expect(audio.type).toBe('audio/mpeg');
    expect(Buffer.compare(audio.body, Buffer.from(MP3))).toBe(0);
    expect(eleven).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(eleven.mock.calls[0]![1]!.body)).text).toBe(script.text);

    // Same card version: served from the cache, for any approver.
    await req(s.dashboardUrl, script.audio, cookieA);
    expect(eleven).toHaveBeenCalledTimes(1);
  });

  it('voice never approves: listening changes nothing, and voice routes accept no POST', async () => {
    const before = (await ticket()).review!;
    await req(s.dashboardUrl, `/api/voice/review/${reviewId}/audio`, cookieB);
    expect((await req(s.dashboardUrl, `/api/voice/review/${reviewId}`, cookieB, { method: 'POST' })).status).toBe(404);
    expect((await req(s.dashboardUrl, `/api/voice/review/${reviewId}/audio`, cookieB, { method: 'POST' })).status).toBe(404);
    const after = (await ticket()).review!;
    expect(after.approved_count).toBe(before.approved_count);
    expect(after.approvals).toEqual(before.approvals);
    expect((await ticket()).stage).toBe('held');
  });

  it('Narrate: after the second approval and payout, a new version is spoken from the timeline', async () => {
    expect((await approve(cookieB)).status).toBe(200);
    await waitFor(async () => (await ticket()).stage === 'paid', { what: 'T-1011 paid' });

    const review = (await req(s.dashboardUrl, `/api/voice/review/${reviewId}`, cookieA)).json() as { text: string; audio: string };
    expect(review.text).toContain('Approval progress: 2 of 2, approved by approver-a and approver-b');
    const calls = eleven.mock.calls.length;
    await req(s.dashboardUrl, review.audio, cookieA);
    expect(eleven).toHaveBeenCalledTimes(calls + 1); // new card version, new audio

    const narration = (await req(s.dashboardUrl, `/api/voice/timeline/${traceId}`, cookieA)).json() as { text: string; audio: string };
    const t = narration.text;
    const order = [
      'Audit trail for ticket T-1011.',
      'The agent made 3 tool calls: get ticket, get order and propose refund.',
      'The validator held 5,000 dollars for review, rule broken: maximum.',
      'approver-a approved.',
      'approver-b approved.',
      'Promoted to approved by approver-a and approver-b.',
      'Paid. fake refund ID re_fake_',
      'Hash chain verified',
    ];
    let at = -1;
    for (const part of order) {
      const i = t.indexOf(part);
      expect(i, `"${part}" after ${at} in: ${t}`).toBeGreaterThan(at);
      at = i;
    }
    const audio = await req(s.dashboardUrl, narration.audio, cookieA);
    expect(audio.type).toBe('audio/mpeg');
    expect((await req(s.dashboardUrl, '/api/voice/timeline/no-such-trace', cookieA)).status).toBe(404);
  });

  it('no key: script with audio null for browser speech, and /audio says unavailable', async () => {
    const calls = eleven.mock.calls.length;
    expect((await req(publicNoKeyUrl, '/api/voice/config', cookieA)).json()).toEqual({ elevenlabs: false, approver: true });
    const script = (await req(publicNoKeyUrl, `/api/voice/review/${reviewId}`, cookieA)).json() as { text: string; audio: null };
    expect(script.audio).toBeNull();
    expect(script.text).toContain('5,000 dollars');
    const audio = await req(publicNoKeyUrl, `/api/voice/review/${reviewId}/audio`, cookieA);
    expect(audio.status).toBe(503);
    expect(audio.json()).toMatchObject({ error: 'voice_unavailable' });
    expect(eleven).toHaveBeenCalledTimes(calls);
  });

  it('ElevenLabs failing gives a 502 the UI falls back from, without the upstream body', async () => {
    eleven.mockImplementationOnce(async () => new Response(JSON.stringify({ detail: `bad key ${KEY}` }), { status: 401 }));
    const fresh = await resolveTicket('T-1010', {
      db: s.agentDb,
      model: 'claude-sonnet-5-5',
      createMessage: scriptedModel(proposeScript('T-1010', 'O-5110', 68_900)).createMessage,
    });
    const res = await req(s.dashboardUrl, `/api/voice/timeline/${fresh.trace_id}/audio`, cookieA);
    expect(res.status).toBe(502);
    expect(res.json()).toMatchObject({ error: 'voice_failed' });
  });

  it('the ElevenLabs key never reaches the browser', () => {
    expect(seen.length).toBeGreaterThan(20);
    for (const chunk of seen) expect(chunk).not.toContain(KEY);
  });
});
