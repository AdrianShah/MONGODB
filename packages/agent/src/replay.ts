/**
 * Replay (DEMO.md "Model call slow"): `npm run batch -- --replay` runs recorded model
 * responses through the real agent loop, so every database write, validator rejection and
 * trace is real; only the model call is skipped. A live batch saves its responses; without
 * one, a recording is built from the seed data's expected outcomes.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { CreateMessage } from './agent.js';

type Message = Anthropic.Beta.Messages.BetaMessage;

export interface Recording {
  version: 1;
  created_at: string;
  /** "live" (saved from a real run) or "expected" (built from data/seed/expected.json). */
  source: 'live' | 'expected';
  model: string;
  tickets: Record<string, Array<{ content: unknown[]; stop_reason: string | null }>>;
}

/** The ticket a request is about, from the first user message ("Resolve support ticket T-1001."). */
export function ticketOf(params: { messages: ReadonlyArray<{ content?: unknown }> }): string {
  const first = params.messages[0]?.content;
  const text = typeof first === 'string' ? first : JSON.stringify(first);
  const match = /\b(T-[\w-]+)/.exec(text);
  if (!match) throw new Error('cannot tell which ticket this request is for');
  return match[1]!;
}

export function emptyRecording(model: string, source: Recording['source'] = 'live'): Recording {
  return { version: 1, created_at: new Date().toISOString(), source, model, tickets: {} };
}

/** Wraps a real model and keeps every response, per ticket, in `rec`. */
export function recordingCreateMessage(inner: CreateMessage, rec: Recording): CreateMessage {
  return async (params) => {
    const ticket = ticketOf(params);
    const res = await inner(params);
    if (params.messages.length === 1) rec.tickets[ticket] = [];
    (rec.tickets[ticket] ??= []).push({ content: res.content as unknown[], stop_reason: res.stop_reason });
    return res;
  };
}

/** Plays `rec` back: each ticket's responses in order, restarting whenever its conversation restarts. */
export function replayCreateMessage(rec: Recording): CreateMessage {
  const cursor = new Map<string, number>();
  return async (params) => {
    const ticket = ticketOf(params);
    const turns = rec.tickets[ticket];
    if (!turns?.length) throw new Error(`no recorded responses for ${ticket}`);
    const i = params.messages.length === 1 ? 0 : (cursor.get(ticket) ?? 0);
    const turn = turns[i];
    if (!turn) throw new Error(`recording for ${ticket} ran out after ${turns.length} responses`);
    cursor.set(ticket, i + 1);
    return {
      id: `msg_replay_${ticket}_${i}`,
      type: 'message',
      role: 'assistant',
      model: `${rec.model} (replay)`,
      content: turn.content,
      stop_reason: turn.stop_reason,
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    } as unknown as Message;
  };
}

interface SeedTicket {
  _id: string;
  order_id: string;
  customer_id: string;
}
interface SeedOrder {
  _id: string;
  items: Array<{ sku: string; name: string; quantity: number; unit_price_cents: number }>;
}
interface Expected {
  ticket_id: string;
  expected_refund_cents: number;
  summary: string;
}

/** A recording that proposes each ticket's expected refund, citing the matching order line. */
export function buildExpectedRecording(tickets: SeedTicket[], orders: SeedOrder[], expected: Expected[]): Recording {
  const rec = emptyRecording('expected-outcomes', 'expected');
  let n = 0;
  const use = (name: string, input: unknown) => ({ type: 'tool_use', id: `toolu_replay_${++n}`, name, input });
  const say = (text: string) => ({ type: 'text', text, citations: null });
  for (const e of expected) {
    const ticket = tickets.find((t) => t._id === e.ticket_id);
    const order = orders.find((o) => o._id === ticket?.order_id);
    if (!ticket || !order) continue;
    const dollars = `$${(e.expected_refund_cents / 100).toFixed(2)}`;
    const line =
      order.items.find((i) => i.unit_price_cents === e.expected_refund_cents) ??
      order.items.find((i) => i.unit_price_cents * i.quantity === e.expected_refund_cents);
    rec.tickets[e.ticket_id] = [
      { content: [say(`Reading ${e.ticket_id}.`), use('get_ticket', { ticket_id: e.ticket_id })], stop_reason: 'tool_use' },
      { content: [use('get_order', { order_id: order._id })], stop_reason: 'tool_use' },
      {
        content: [
          say(`The order supports a refund of ${dollars}.`),
          use('propose_refund', {
            order_id: order._id,
            amount_cents: e.expected_refund_cents,
            reason: e.summary,
            evidence: [
              { kind: 'ticket', ref: e.ticket_id, note: 'Customer statement in the ticket.' },
              line
                ? { kind: 'order_line', ref: line.sku, note: `${line.name}, ${line.quantity} x $${(line.unit_price_cents / 100).toFixed(2)}` }
                : { kind: 'order', ref: order._id, note: `Refund of ${dollars} against this order.` },
            ],
          }),
        ],
        stop_reason: 'tool_use',
      },
      { content: [say(`Proposed ${dollars} for ${e.ticket_id}.`)], stop_reason: 'end_turn' },
    ];
  }
  return rec;
}
