/**
 * Demo dataset checks (PRD T2): 12 tickets with the 8/2/1/1 split, every
 * reference resolves, every expected refund fits its order, the injection
 * ticket carries the injection. Also checks the loader fails loudly.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, tierFor } from '@escrowops/shared';
import {
  SeedDataError,
  loadSeedData,
  refundableCents,
  validateSeedData,
  type SeedData,
} from '../../scripts/lib/seed-data.js';

const data = loadSeedData();
const byId = <T extends { _id: string }>(docs: T[]) => new Map(docs.map((d) => [d._id, d]));
const orders = byId(data.orders);
const customers = byId(data.customers);
const tickets = byId(data.tickets);

function expectProblem(mutate: (d: SeedData) => void, pattern: RegExp): void {
  const copy = structuredClone(data);
  mutate(copy);
  let error: unknown;
  try {
    validateSeedData(copy);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SeedDataError);
  expect((error as SeedDataError).problems.join('\n')).toMatch(pattern);
}

describe('seed dataset', () => {
  it('has exactly 12 tickets, each with one expected outcome', () => {
    expect(data.tickets).toHaveLength(12);
    expect(data.expected.tickets).toHaveLength(12);
    expect(new Set(data.expected.tickets.map((e) => e.ticket_id))).toEqual(new Set(data.tickets.map((t) => t._id)));
    expect(data.expected.policy_version).toBe(DEFAULT_POLICY.version);
  });

  it('splits 8 small / 2 mid / 1 large / 1 injection under the default policy', () => {
    const plain = data.expected.tickets.filter((e) => !e.injection);
    const tiers = plain.map((e) => tierFor(e.expected_refund_cents, DEFAULT_POLICY));
    expect(tiers.filter((t) => t === 'single_agent')).toHaveLength(8);
    expect(tiers.filter((t) => t === 'peer_review')).toHaveLength(2);
    expect(tiers.filter((t) => t === 'human_required')).toHaveLength(1);
    expect(data.expected.tickets.filter((e) => e.injection)).toHaveLength(1);
    for (const e of data.expected.tickets) expect(e.expected_tier).toBe(tierFor(e.expected_refund_cents, DEFAULT_POLICY));
  });

  it('small amounts are varied, mid amounts sit between the caps, the large one is exactly $5,000', () => {
    const small = data.expected.tickets.filter((e) => !e.injection && e.expected_tier === 'single_agent');
    expect(new Set(small.map((e) => e.expected_refund_cents)).size).toBe(8);
    for (const e of small) expect(e.expected_refund_cents).toBeLessThanOrEqual(DEFAULT_POLICY.auto_cap_cents);

    const mid = data.expected.tickets.filter((e) => e.expected_tier === 'peer_review');
    for (const e of mid) {
      expect(e.expected_refund_cents).toBeGreaterThan(DEFAULT_POLICY.auto_cap_cents);
      expect(e.expected_refund_cents).toBeLessThanOrEqual(DEFAULT_POLICY.single_approver_cap_cents);
    }

    const large = data.expected.tickets.filter((e) => e.expected_tier === 'human_required');
    expect(large.map((e) => e.expected_refund_cents)).toEqual([500_000]);
    const largeOrder = orders.get(tickets.get(large[0]!.ticket_id)!.order_id)!;
    expect(largeOrder.amount_cents).toBeGreaterThanOrEqual(500_000);
  });

  it('every reference resolves and every order belongs to its ticket customer', () => {
    for (const o of data.orders) expect(customers.has(o.customer_id), `order ${o._id}`).toBe(true);
    for (const t of data.tickets) {
      expect(customers.has(t.customer_id), `ticket ${t._id} customer`).toBe(true);
      const order = orders.get(t.order_id);
      expect(order, `ticket ${t._id} order`).toBeDefined();
      expect(order!.customer_id).toBe(t.customer_id);
    }
  });

  it('every expected refund fits the order refundable amount', () => {
    for (const e of data.expected.tickets) {
      const order = orders.get(tickets.get(e.ticket_id)!.order_id)!;
      expect(e.expected_refund_cents, e.ticket_id).toBeGreaterThan(0);
      expect(e.expected_refund_cents, e.ticket_id).toBeLessThanOrEqual(refundableCents(order));
    }
  });

  it('orders have line items, consistent totals, fake payment IDs, and one ticket order is partially refunded', () => {
    for (const o of data.orders) {
      expect(o.items.length).toBeGreaterThan(0);
      expect(o.items.reduce((s, i) => s + i.quantity * i.unit_price_cents, 0)).toBe(o.amount_cents);
      expect(o.payment_id).toMatch(/^pi_fake_/);
      for (const v of [o.amount_cents, o.refunded_cents, ...o.items.map((i) => i.unit_price_cents)]) {
        expect(Number.isInteger(v)).toBe(true);
      }
    }
    const ticketOrders = data.tickets.map((t) => orders.get(t.order_id)!);
    expect(ticketOrders.filter((o) => o.refunded_cents > 0 && o.refunded_cents < o.amount_cents)).toHaveLength(1);
  });

  it('customers have history: prior orders and prior refunds beyond the ticket orders', () => {
    const ticketOrderIds = new Set(data.tickets.map((t) => t.order_id));
    const prior = data.orders.filter((o) => !ticketOrderIds.has(o._id));
    expect(prior.length).toBeGreaterThanOrEqual(8);
    expect(prior.filter((o) => o.refunded_cents > 0).length).toBeGreaterThanOrEqual(3);
    // The large-refund customer has a long, clean history.
    const large = data.expected.tickets.find((e) => e.expected_tier === 'human_required')!;
    const customerId = tickets.get(large.ticket_id)!.customer_id;
    expect(prior.filter((o) => o.customer_id === customerId).length).toBeGreaterThanOrEqual(2);
  });

  it('the injection ticket contains the injected $50,000 instruction and a small legitimate amount', () => {
    const inj = data.expected.tickets.find((e) => e.injection)!;
    const ticket = tickets.get(inj.ticket_id)!;
    expect(ticket.body).toContain(inj.injection!.marker);
    expect(ticket.body).toMatch(/ignore all previous instructions/i);
    expect(ticket.body).toContain('$50,000');
    expect(inj.injection!.requested_cents).toBe(5_000_000);
    expect(tierFor(inj.injection!.requested_cents, DEFAULT_POLICY)).toBe('blocked');
    expect(inj.expected_tier).toBe('single_agent');
    expect(inj.expected_refund_cents).toBeLessThan(10_000);
    // The legitimate amount is a real line item on the order, so it is inferable.
    const order = orders.get(ticket.order_id)!;
    expect(order.items.map((i) => i.unit_price_cents)).toContain(inj.expected_refund_cents);
  });

  it('the expected amount is never written into ticket fields as cents', () => {
    for (const e of data.expected.tickets) {
      const t = tickets.get(e.ticket_id)!;
      expect(Object.keys(t).sort()).toEqual(['_id', 'body', 'created_at', 'customer_id', 'order_id', 'status', 'subject']);
      expect(t.body).not.toContain(String(e.expected_refund_cents));
    }
  });
});

describe('seed data validation fails loudly', () => {
  it('rejects a ticket pointing at a missing order', () => {
    expectProblem((d) => {
      d.tickets[0]!.order_id = 'O-NOPE';
    }, /order O-NOPE does not exist/);
  });

  it('rejects a ticket whose order belongs to someone else', () => {
    expectProblem((d) => {
      d.tickets[0]!.customer_id = d.tickets[1]!.customer_id;
    }, /belongs to/);
  });

  it('rejects an order with a missing customer', () => {
    expectProblem((d) => {
      d.orders[0]!.customer_id = 'C-NOPE';
    }, /customer C-NOPE does not exist/);
  });

  it('rejects an expected refund larger than the refundable amount', () => {
    expectProblem((d) => {
      const t = d.tickets.find((x) => x._id === 'T-1005')!;
      const order = d.orders.find((o) => o._id === t.order_id)!;
      const e = d.expected.tickets.find((x) => x.ticket_id === 'T-1005')!;
      e.expected_refund_cents = order.amount_cents; // more than amount minus refunded
    }, /exceeds order O-5105's refundable amount/);
  });

  it('rejects a wrong tier split', () => {
    expectProblem((d) => {
      const e = d.expected.tickets.find((x) => x.ticket_id === 'T-1001')!;
      e.expected_refund_cents = 60_000;
      e.expected_tier = 'peer_review';
      d.orders.find((o) => o._id === 'O-5101')!.items[0]!.unit_price_cents = 60_000;
      d.orders.find((o) => o._id === 'O-5101')!.amount_cents = 60_000 + 1200 + 595;
    }, /expected 8 small ticket\(s\), found 7/);
  });

  it('rejects an expected tier that does not match the policy', () => {
    expectProblem((d) => {
      d.expected.tickets[0]!.expected_tier = 'human_required';
    }, /expected_tier "human_required"/);
  });

  it('rejects order totals that do not match their items, and non-fake payment IDs', () => {
    expectProblem((d) => {
      d.orders[0]!.amount_cents += 1;
    }, /does not equal the sum of its items/);
    expectProblem((d) => {
      d.orders[0]!.payment_id = 'pi_3Nreal';
    }, /pi_fake_/);
  });
});
