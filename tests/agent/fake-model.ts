/** A scripted stand-in for Claude, so the agent loop runs without the API (TEST_PLAN: the model is the only non-deterministic part). */
import type Anthropic from '@anthropic-ai/sdk';
import type { CreateMessage } from '@escrowops/agent';

type Message = Anthropic.Beta.Messages.BetaMessage;
type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Block = Record<string, unknown>;

let ids = 0;

export const toolUse = (name: string, input: Record<string, unknown>): Block => ({
  type: 'tool_use',
  id: `toolu_${++ids}`,
  name,
  input,
});
export const text = (t: string): Block => ({ type: 'text', text: t, citations: null });

export function message(content: Block[], stop_reason = content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'): Message {
  return {
    id: `msg_${++ids}`,
    type: 'message',
    role: 'assistant',
    model: 'fake-model',
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Message;
}

/** Replies with each scripted turn in order and records every request it was sent. */
export function scriptedModel(turns: Array<Message | ((params: Params) => Message)>) {
  const requests: Params[] = [];
  const createMessage: CreateMessage = async (params) => {
    requests.push(structuredClone(params));
    const next = turns.shift();
    if (!next) throw new Error('scripted model ran out of turns');
    return typeof next === 'function' ? next(params) : next;
  };
  return { createMessage, requests };
}

/** The usual path: read the ticket and order, then propose. */
export function proposeScript(ticketId: string, orderId: string, amount_cents: number) {
  return [
    message([toolUse('get_ticket', { ticket_id: ticketId })]),
    message([toolUse('get_order', { order_id: orderId })]),
    message([
      text('The order line supports this amount.'),
      toolUse('propose_refund', {
        order_id: orderId,
        amount_cents,
        reason: 'Refunding the affected line item at its order price, as the ticket describes.',
        evidence: [{ kind: 'order_line', ref: orderId, note: 'Line item price from the order.' }],
      }),
    ]),
    message([text('Proposed the refund.')]),
  ];
}
