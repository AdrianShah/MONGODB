/**
 * Groq adapter: the agent's Messages-shaped loop over Groq's OpenAI-compatible chat
 * completions. A scripted fake Groq server stands in for the network.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';
import { COLLECTIONS, type IntentDoc } from '@escrowops/shared';
import {
  fromChatResponse,
  groqCreateMessage,
  GroqError,
  GROQ_DEFAULT_MODEL,
  InvalidAgentEnvError,
  liveCreateMessage,
  loadAgentSettings,
  resolveTicket,
  toChatMessages,
  toChatTools,
  TOOLS,
} from '@escrowops/agent';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { resetDatabase, seedDatabase } from '../../scripts/lib/seed-data.js';

type Body = { model: string; messages: Array<Record<string, unknown>>; tools: unknown[]; max_completion_tokens: number; reasoning_effort?: string };

const completion = (message: Record<string, unknown>, finish_reason = 'stop') => ({
  id: 'chatcmpl-test',
  model: GROQ_DEFAULT_MODEL,
  choices: [{ finish_reason, message: { role: 'assistant', ...message } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});
const call = (id: string, name: string, args: unknown) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

/** A fake Groq endpoint: answers each POST with the next scripted response and records bodies. */
function fakeGroq(script: Array<{ status?: number; json?: unknown; text?: string; headers?: Record<string, string> }>) {
  const bodies: Body[] = [];
  const auth: string[] = [];
  let i = 0;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as Body);
    auth.push(new Headers(init.headers).get('authorization') ?? '');
    const step = script[Math.min(i++, script.length - 1)]!;
    const status = step.status ?? 200;
    return new Response(step.json !== undefined ? JSON.stringify(step.json) : (step.text ?? ''), {
      status,
      headers: { 'content-type': 'application/json', ...(step.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { fetchFn, bodies, auth };
}

describe('settings', () => {
  it('uses Groq when GROQ_API_KEY is set, with free-tier friendly defaults', () => {
    const s = loadAgentSettings({ GROQ_API_KEY: 'gsk_test' });
    expect(s).toMatchObject({ provider: 'groq', model: GROQ_DEFAULT_MODEL, concurrency: 1 });
  });
  it('keeps Anthropic as the default without a Groq key, and AGENT_PROVIDER overrides', () => {
    expect(loadAgentSettings({})).toMatchObject({ provider: 'anthropic', model: 'claude-sonnet-5-5', concurrency: 4 });
    expect(loadAgentSettings({ GROQ_API_KEY: 'gsk_test', AGENT_PROVIDER: 'anthropic' }).provider).toBe('anthropic');
    expect(loadAgentSettings({ GROQ_API_KEY: 'gsk_test', AGENT_MODEL: 'openai/gpt-oss-20b' }).model).toBe('openai/gpt-oss-20b');
    expect(() => loadAgentSettings({ AGENT_PROVIDER: 'openai' })).toThrow(InvalidAgentEnvError);
  });
  it('asks for GROQ_API_KEY when Groq is forced without one', () => {
    expect(() => liveCreateMessage({ provider: 'groq' }, {})).toThrow(/GROQ_API_KEY/);
  });
});

describe('translation', () => {
  it('maps system, tool calls and tool results (errors marked) to chat messages', () => {
    const msgs = toChatMessages({
      system: [{ type: 'text', text: 'SYS' }],
      messages: [
        { role: 'user', content: 'Resolve support ticket T-1.' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Reading.', citations: null },
            { type: 'tool_use', id: 'c1', name: 'get_ticket', input: { ticket_id: 'T-1' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'c1', content: '{"ok":true}' },
            { type: 'tool_result', tool_use_id: 'c2', content: 'bad order', is_error: true },
          ],
        },
      ],
    } as never);
    expect(msgs).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'Resolve support ticket T-1.' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_ticket', arguments: '{"ticket_id":"T-1"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'c2', content: 'Error: bad order' },
    ]);
  });

  it('maps every agent tool to a function tool with its JSON schema', () => {
    const tools = toChatTools(TOOLS);
    expect(tools.map((t) => t.function.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools[0]!.function.parameters).toEqual(TOOLS[0]!.input_schema);
    expect(JSON.stringify(tools)).not.toContain('strict');
  });

  it('maps a reply with reasoning, text and tool calls back to Messages blocks', () => {
    const m = fromChatResponse(
      completion({ reasoning: 'think', content: 'ok', tool_calls: [call('c9', 'get_order', { order_id: 'O-1' }), { id: 'c10', type: 'function', function: { name: 'x', arguments: '{bad' } }] }, 'tool_calls') as never,
      'm',
    );
    expect(m.stop_reason).toBe('tool_use');
    expect(m.content.map((b) => b.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_use']);
    expect(m.content[2]).toMatchObject({ id: 'c9', name: 'get_order', input: { order_id: 'O-1' } });
    expect(m.content[3]).toMatchObject({ input: { _unparsed_arguments: '{bad' } });
    expect(fromChatResponse(completion({ content: 'cut' }, 'length') as never, 'm').stop_reason).toBe('max_tokens');
  });
});

describe('transport', () => {
  const params = { model: GROQ_DEFAULT_MODEL, max_tokens: 16000, messages: [{ role: 'user' as const, content: 'hi' }], output_config: { effort: 'xhigh' } };

  it('sends the key as a bearer token, caps completion tokens and maps effort for gpt-oss', async () => {
    const g = fakeGroq([{ json: completion({ content: 'hello' }) }]);
    const create = groqCreateMessage({ apiKey: 'gsk_secret', fetch: g.fetchFn, maxTokens: 1024 });
    const m = await create(params as never);
    expect(m.content).toMatchObject([{ type: 'text', text: 'hello' }]);
    expect(g.auth[0]).toBe('Bearer gsk_secret');
    expect(g.bodies[0]).toMatchObject({ model: GROQ_DEFAULT_MODEL, max_completion_tokens: 1024, reasoning_effort: 'high', parallel_tool_calls: false });
  });

  it('waits out a 429 using retry-after, and resamples a malformed tool call', async () => {
    const waits: number[] = [];
    const g = fakeGroq([
      { status: 429, text: '{"error":{"message":"Rate limit reached. Please try again in 1.5s."}}', headers: { 'retry-after': '2' } },
      { status: 400, text: '{"error":{"code":"tool_use_failed","message":"Failed to call a function."}}' },
      { json: completion({ content: 'done' }) },
    ]);
    const create = groqCreateMessage({ apiKey: 'k', fetch: g.fetchFn, sleep: async (ms) => void waits.push(ms), log: () => {} });
    const m = await create(params as never);
    expect(m.content).toMatchObject([{ text: 'done' }]);
    expect(waits).toEqual([2250, 250]);
  });

  it('fails without retrying on a bad key', async () => {
    const g = fakeGroq([{ status: 401, text: '{"error":{"message":"Invalid API Key"}}' }]);
    const create = groqCreateMessage({ apiKey: 'k', fetch: g.fetchFn, log: () => {} });
    await expect(create(params as never)).rejects.toBeInstanceOf(GroqError);
    expect(g.bodies).toHaveLength(1);
  });
});

describe('agent loop on Groq', () => {
  const t = useTestDb('groq');
  let agentDb: Db;
  beforeAll(async () => {
    await setUpAccess(t());
    await seedDatabase(t().db);
    agentDb = (await t().connectAsRole('agent')).db(t().dbName);
  });
  beforeEach(async () => {
    await resetDatabase(t().db);
  });

  it('resolves T-1001 end to end: tool calls round-trip and the $89 intent lands', async () => {
    const g = fakeGroq([
      { json: completion({ content: null, tool_calls: [call('c1', 'get_ticket', { ticket_id: 'T-1001' })] }, 'tool_calls') },
      { json: completion({ content: null, tool_calls: [call('c2', 'get_order', { order_id: 'O-5101' })] }, 'tool_calls') },
      {
        json: completion(
          {
            content: 'The order line supports this amount.',
            tool_calls: [
              call('c3', 'propose_refund', {
                order_id: 'O-5101',
                amount_cents: 8900,
                reason: 'Refunding the affected line item at its order price, as the ticket describes.',
                evidence: [{ kind: 'order_line', ref: 'O-5101', note: 'Line item price from the order.' }],
              }),
            ],
          },
          'tool_calls',
        ),
      },
      { json: completion({ content: 'Proposed an $89 refund.' }) },
    ]);
    const createMessage = groqCreateMessage({ apiKey: 'k', fetch: g.fetchFn, log: () => {} });
    const r = await resolveTicket('T-1001', { db: agentDb, createMessage, model: GROQ_DEFAULT_MODEL });

    expect(r.status).toBe('proposed');
    expect(await t().db.collection<IntentDoc>(COLLECTIONS.intents).findOne({ ticket_id: 'T-1001' })).toMatchObject({ amount_cents: 8900 });
    // The second request carries the first tool call and its result back to Groq.
    const second = g.bodies[1]!.messages;
    expect(second[0]).toMatchObject({ role: 'system' });
    expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'get_ticket' } }] });
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'c1' });
    expect(String(second.at(-1)!['content'])).toContain('O-5101');
    expect(g.bodies[0]!.tools).toHaveLength(TOOLS.length);
  });
});
