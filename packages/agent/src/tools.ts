/**
 * The agent's tools (PRD A1, A2, A4, A6). Each runs as the agent database user,
 * which can read source data and insert proposals and traces, nothing else.
 *
 * The tools are deliberately not the guardrail: the validator on `intents`, the
 * unique indexes and the roles are. A proposal over the auto cap is simply
 * rejected by the server (121) and parked in `review_queue`, where it cannot pay.
 */
import { createHash } from 'node:crypto';
import { MongoServerError, ObjectId, type Db } from 'mongodb';
import type Anthropic from '@anthropic-ai/sdk';
import {
  COLLECTIONS,
  REQUIRED_APPROVALS,
  searchPrecedents,
  tierFor,
  type CustomerDoc,
  type Evidence,
  type IntentDoc,
  type OrderDoc,
  type Policy,
  type ReviewQueueDoc,
  type TicketDoc,
} from '@escrowops/shared';
import type { TraceWriter } from './trace.js';

/** A4: one key per ticket and order. Same format as scripts/lib/redteam-attacks.ts. */
export function idempotencyKey(ticketId: string, orderId: string): string {
  return createHash('sha256').update(`${ticketId}|${orderId}`).digest('hex');
}

export const TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: 'get_ticket',
    description: 'Read a support ticket: customer, order, subject and the customer-written body.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { ticket_id: { type: 'string', description: 'Ticket ID, e.g. "T-1001".' } },
      required: ['ticket_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_order',
    description:
      'Read an order: owning customer, line items with unit prices in cents, total, amount already refunded, status and date.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { order_id: { type: 'string', description: 'Order ID, e.g. "O-5101".' } },
      required: ['order_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_customer_history',
    description: "Read a customer's profile, all of their orders, and their other support tickets (subjects only).",
    strict: true,
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'string', description: 'Customer ID, e.g. "C-1001".' } },
      required: ['customer_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_precedents',
    description:
      'Search past resolved disputes for ones like this ticket (Atlas Vector Search). Returns the closest precedents with their ' +
      'outcome, refund and rationale. Useful when the right amount or outcome is unclear. Cite a precedent you rely on as ' +
      'evidence with kind "precedent" and ref set to its precedent_id.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A short description of the dispute, e.g. "two of six glasses broken, kept the rest".' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_refund',
    description:
      'Propose a refund for the ticket being resolved. Call at most once, after checking the order. ' +
      'Small refunds are paid automatically; larger ones are held for human approval. The result says which happened.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The order to refund against.' },
        amount_cents: { type: 'integer', description: 'Refund amount in integer cents, e.g. 8900 for $89.00.' },
        reason: {
          type: 'string',
          description: 'Why this amount is right, in 1 to 4 sentences, citing the facts you checked (at least 20 characters).',
        },
        evidence: {
          type: 'array',
          description: 'The facts the amount rests on, e.g. the order line item and the ticket statement.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: 'e.g. "order_line", "ticket", "order", "customer_history".' },
              ref: { type: 'string', description: 'ID or SKU the evidence points at.' },
              note: { type: 'string', description: 'What it shows.' },
            },
            required: ['kind', 'ref', 'note'],
            additionalProperties: false,
          },
        },
      },
      required: ['order_id', 'amount_cents', 'reason', 'evidence'],
      additionalProperties: false,
    },
  },
  {
    name: 'decline_refund',
    description:
      'Decline to refund this ticket and record why, e.g. outside the return window, already refunded, or the order is not the customer\'s.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Why no refund is due, citing the facts you checked.' } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

export type Decision =
  | { status: 'proposed'; collection: 'intents'; amount_cents: number; proposal_id: ObjectId }
  | {
      status: 'held';
      collection: 'review_queue';
      amount_cents: number;
      proposal_id: ObjectId;
      tier: ReviewQueueDoc['tier'];
      required_approvals: number;
      rules: string[];
      /** The server's reasons, e.g. "amount_cents: 500000 — maximum 50000". */
      violations: string[];
    }
  | { status: 'already_proposed'; amount_cents: number }
  | { status: 'declined'; reason: string };

export interface ToolContext {
  db: Db;
  policy: Policy;
  trace: TraceWriter;
  ticket: TicketDoc;
}

export class ToolError extends Error {}

/**
 * The server refused a proposal with Unauthorized (code 13): the kill switch removed the agent
 * role's insert privilege (packages/shared/src/killswitch.ts). Not a tool error the model can
 * work around: the batch stops.
 */
export class AgentFrozenError extends Error {
  constructor(
    readonly collection: string,
    readonly serverError: MongoServerError,
  ) {
    super(`agent frozen: MongoDB refused insert on ${collection} (code 13 ${serverError.codeName ?? 'Unauthorized'})`);
    this.name = 'AgentFrozenError';
  }
}

/** True when `err` is the server's Unauthorized (13), which is what a frozen agent gets. */
export function isUnauthorized(err: unknown): err is MongoServerError {
  return err instanceof MongoServerError && err.code === 13;
}

/** Runs the model's tool calls for one ticket and remembers the decision, if any. */
export class TicketTools {
  decision: Decision | undefined;

  constructor(private readonly ctx: ToolContext) {}

  async run(name: string, input: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'get_ticket':
        return this.getTicket(String(input['ticket_id']));
      case 'get_order':
        return this.getOrder(String(input['order_id']));
      case 'get_customer_history':
        return this.getCustomerHistory(String(input['customer_id']));
      case 'search_precedents':
        return searchPrecedents(this.ctx.db, String(input['query'] ?? ''));
      case 'propose_refund':
        return this.proposeRefund(input as unknown as ProposeInput);
      case 'decline_refund':
        return this.declineRefund(String(input['reason']));
      default:
        throw new ToolError(`unknown tool "${name}"`);
    }
  }

  private async getTicket(id: string) {
    const ticket = await this.ctx.db.collection<TicketDoc>(COLLECTIONS.tickets).findOne({ _id: id });
    if (!ticket) throw new ToolError(`ticket ${id} not found`);
    return ticket;
  }

  private async getOrder(id: string) {
    const order = await this.ctx.db.collection<OrderDoc>(COLLECTIONS.orders).findOne({ _id: id });
    if (!order) throw new ToolError(`order ${id} not found`);
    return order;
  }

  private async getCustomerHistory(id: string) {
    const db = this.ctx.db;
    const customer = await db.collection<CustomerDoc>(COLLECTIONS.customers).findOne({ _id: id });
    if (!customer) throw new ToolError(`customer ${id} not found`);
    const orders = await db.collection<OrderDoc>(COLLECTIONS.orders).find({ customer_id: id }).sort({ created_at: 1 }).toArray();
    const tickets = await db
      .collection<TicketDoc>(COLLECTIONS.tickets)
      .find({ customer_id: id }, { projection: { body: 0 } })
      .sort({ created_at: 1 })
      .toArray();
    return { customer, orders, tickets };
  }

  private async proposeRefund(input: ProposeInput) {
    if (this.decision) throw new ToolError('a decision has already been recorded for this ticket');
    const { db, policy, trace, ticket } = this.ctx;

    const proposal: IntentDoc = {
      _id: new ObjectId(),
      trace_id: trace.traceId,
      ticket_id: ticket._id,
      order_id: input.order_id,
      // From the ticket, not the model: the refund goes to the customer who raised it.
      customer_id: ticket.customer_id,
      amount_cents: input.amount_cents,
      currency: 'usd',
      reason: input.reason,
      evidence: input.evidence,
      policy_version: policy.version,
      idempotency_key: idempotencyKey(ticket._id, input.order_id),
      created_at: new Date(),
    };

    try {
      await db.collection<IntentDoc>(COLLECTIONS.intents).insertOne(proposal);
      this.decision = { status: 'proposed', collection: 'intents', amount_cents: proposal.amount_cents, proposal_id: proposal._id };
      await trace.write('decision', { tool: 'propose_refund', output: this.decision });
      return { outcome: 'approved_automatically', amount_cents: proposal.amount_cents, note: 'The refund will be paid out.' };
    } catch (err) {
      if (isUnauthorized(err)) throw new AgentFrozenError(COLLECTIONS.intents, err);
      if (isCode(err, 11000)) return this.alreadyProposed(proposal.amount_cents);
      if (!isCode(err, 121)) throw err;

      // A2: the server refused it as an auto refund. Park the same proposal for humans.
      const serverError = err as MongoServerError;
      const tier = tierFor(proposal.amount_cents, policy);
      const review: ReviewQueueDoc = {
        ...proposal,
        tier,
        required_approvals: tier === 'blocked' ? REQUIRED_APPROVALS.human_required : REQUIRED_APPROVALS[tier],
        status: 'pending',
        validator_error: { code: 121, errmsg: serverError.errmsg ?? serverError.message, errInfo: serverError.errInfo },
      };
      try {
        await db.collection<ReviewQueueDoc>(COLLECTIONS.review_queue).insertOne(review);
      } catch (inner) {
        if (isUnauthorized(inner)) throw new AgentFrozenError(COLLECTIONS.review_queue, inner);
        if (isCode(inner, 11000)) return this.alreadyProposed(proposal.amount_cents);
        throw inner;
      }
      this.decision = {
        status: 'held',
        collection: 'review_queue',
        amount_cents: proposal.amount_cents,
        proposal_id: review._id,
        tier,
        required_approvals: review.required_approvals,
        rules: failedRules(serverError.errInfo),
        violations: describeViolations(serverError.errInfo),
      };
      await trace.write('decision', { tool: 'propose_refund', output: { ...this.decision, validator_error: review.validator_error } });
      return {
        outcome: 'held_for_human_review',
        amount_cents: proposal.amount_cents,
        tier,
        required_approvals: review.required_approvals,
        note: 'The database did not accept this as an automatic refund. It is queued for human approval; no money moves until then.',
      };
    }
  }

  private async alreadyProposed(amount_cents: number) {
    this.decision = { status: 'already_proposed', amount_cents };
    await this.ctx.trace.write('decision', { tool: 'propose_refund', output: this.decision });
    return { outcome: 'already_proposed', note: 'A refund for this ticket and order was proposed earlier. Nothing new was created.' };
  }

  private async declineRefund(reason: string) {
    if (this.decision) throw new ToolError('a decision has already been recorded for this ticket');
    this.decision = { status: 'declined', reason };
    await this.ctx.trace.write('decision', { tool: 'decline_refund', output: this.decision });
    return { outcome: 'declined', note: 'Recorded. No refund will be issued.' };
  }
}

interface ProposeInput {
  order_id: string;
  amount_cents: number;
  reason: string;
  evidence: Evidence[];
}

function isCode(err: unknown, code: number): boolean {
  return err instanceof MongoServerError && err.code === code;
}

/**
 * One line per failed property in a 121's errInfo, e.g. "amount_cents: 500000 — maximum 50000"
 * or "additionalProperties: approvals". Falls back to the rule names.
 */
export function describeViolations(errInfo: unknown): string[] {
  const lines: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n['propertyName'] === 'string' && Array.isArray(n['details'])) {
      for (const d of n['details'] as Array<Record<string, unknown>>) {
        const op = String(d['operatorName'] ?? 'rule');
        const limit = (d['specifiedAs'] as Record<string, unknown> | undefined)?.[op];
        const value = d['consideredValue'];
        lines.push(
          `${n['propertyName']}: ${value === undefined ? '' : `${JSON.stringify(value)} — `}${op}${limit === undefined ? '' : ` ${JSON.stringify(limit)}`}`,
        );
      }
      return;
    }
    if (n['operatorName'] === 'additionalProperties' && Array.isArray(n['additionalProperties'])) {
      lines.push(`additionalProperties: ${(n['additionalProperties'] as string[]).join(', ')}`);
    }
    if (n['operatorName'] === 'required' && Array.isArray(n['missingProperties'])) {
      lines.push(`required: missing ${(n['missingProperties'] as string[]).join(', ')}`);
    }
    Object.values(n).forEach(walk);
  };
  walk(errInfo);
  return lines.length ? lines : failedRules(errInfo);
}

/** The validator rules a 121 names, e.g. ["maximum"], from `errInfo.details`. */
export function failedRules(errInfo: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'operatorName' && typeof value === 'string' && !['$jsonSchema', 'properties', '$and'].includes(value)) {
          found.add(value);
        }
        walk(value);
      }
    }
  };
  walk(errInfo);
  return [...found];
}
