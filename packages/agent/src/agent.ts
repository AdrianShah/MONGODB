/**
 * One ticket, one trace: a manual tool-use loop so every tool call, result and
 * stated reason lands in `agent_traces` in order (A3), and the loop stops once a
 * decision is recorded.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type Anthropic from '@anthropic-ai/sdk';
import { COLLECTIONS, DEFAULT_POLICY, type Policy, type PolicyDoc, type TicketDoc } from '@escrowops/shared';
import { SYSTEM_PROMPT } from './prompt.js';
import { TicketTools, TOOLS, ToolError, type Decision } from './tools.js';
import { TraceWriter } from './trace.js';

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** Sends one request. The default wraps `client.beta.messages.create`; tests pass a scripted fake. */
export type CreateMessage = (params: CreateParams) => Promise<Message>;

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AgentOptions {
  db: Db;
  createMessage: CreateMessage;
  model: string;
  effort?: Effort;
  /** Server-side refusal fallback (`fallbacks: "default"`). On by default. */
  fallbacks?: boolean;
  /** Model round trips per ticket before giving up. */
  maxTurns?: number;
  policy?: Policy;
}

export type TicketStatus = Decision['status'] | 'no_decision' | 'refused' | 'error';

export interface TicketResult {
  ticket_id: string;
  trace_id: string;
  status: TicketStatus;
  decision?: Decision;
  detail?: string;
  turns: number;
}

export function anthropicCreateMessage(client: Anthropic): CreateMessage {
  return (params) => client.beta.messages.create(params);
}

/** The active policy document, or the default if none is seeded. */
export async function loadActivePolicy(db: Db): Promise<Policy> {
  const doc = await db.collection<PolicyDoc>(COLLECTIONS.policies).findOne({ active: true }, { sort: { version: -1 } });
  if (!doc) return DEFAULT_POLICY;
  return {
    version: doc.version,
    auto_cap_cents: doc.auto_cap_cents,
    single_approver_cap_cents: doc.single_approver_cap_cents,
    hard_cap_cents: doc.hard_cap_cents,
  };
}

export async function resolveTicket(ticketId: string, opts: AgentOptions): Promise<TicketResult> {
  const traceId = `tr_${randomUUID()}`;
  const trace = new TraceWriter(opts.db, traceId, ticketId);
  const result = (status: TicketStatus, turns: number, extra: Partial<TicketResult> = {}): TicketResult => ({
    ticket_id: ticketId,
    trace_id: traceId,
    status,
    turns,
    ...extra,
  });

  const ticket = await opts.db.collection<TicketDoc>(COLLECTIONS.tickets).findOne({ _id: ticketId });
  if (!ticket) {
    await trace.write('error', { text: `ticket ${ticketId} not found` });
    return result('error', 0, { detail: 'ticket not found' });
  }

  const policy = opts.policy ?? (await loadActivePolicy(opts.db));
  const tools = new TicketTools({ db: opts.db, policy, trace, ticket });
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    { role: 'user', content: `Resolve support ticket ${ticketId}.` },
  ];
  const maxTurns = opts.maxTurns ?? 12;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await opts.createMessage({
      model: opts.model,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: opts.effort ?? 'medium' },
      ...(opts.fallbacks === false ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    });

    for (const block of response.content) {
      if (block.type === 'thinking' && block.thinking.trim()) await trace.write('reasoning', { text: block.thinking });
      if (block.type === 'text' && block.text.trim()) await trace.write('reasoning', { text: block.text });
    }

    if (response.stop_reason === 'refusal') {
      const detail = `model declined (${response.stop_details?.category ?? 'no category'})`;
      await trace.write('error', { text: detail });
      return result(tools.decision?.status ?? 'refused', turn, { decision: tools.decision, detail });
    }
    if (response.stop_reason === 'max_tokens') {
      await trace.write('error', { text: 'response hit max_tokens' });
      return result(tools.decision?.status ?? 'error', turn, { decision: tools.decision, detail: 'max_tokens' });
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use',
    );
    if (toolUses.length === 0) {
      if (tools.decision) return result(tools.decision.status, turn, { decision: tools.decision });
      await trace.write('error', { text: 'model finished without proposing or declining' });
      return result('no_decision', turn);
    }

    messages.push({ role: 'assistant', content: response.content });
    const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
    for (const call of toolUses) {
      const input = call.input as Record<string, unknown>;
      await trace.write('tool_call', { tool: call.name, input });
      try {
        const output = await tools.run(call.name, input);
        await trace.write('tool_result', { tool: call.name, output });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(output) });
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        await trace.write('tool_result', { tool: call.name, output: { error: err.message } });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: err.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  if (tools.decision) return result(tools.decision.status, maxTurns, { decision: tools.decision });
  await trace.write('error', { text: `no decision after ${maxTurns} turns` });
  return result('no_decision', maxTurns, { detail: 'turn limit' });
}
