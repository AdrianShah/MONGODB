/** T2 and T4, payment side: fresh payments per ticket order, and a cleared fake provider on reset. */
import { describe, expect, it } from 'vitest';
import { COLLECTIONS, type OrderDoc } from '@escrowops/shared';
import { startFakeProviderServer } from '@escrowops/executor';
import { useTestDb } from '../helpers/index.js';
import { loadSeedData, resetDatabase, seedDatabase } from '../../scripts/lib/seed-data.js';
import { clearFakeProvider, seedPaymentHook } from '../../scripts/lib/payments.js';

const t = useTestDb('payments_seed');

describe('seed with a payment hook (PAYMENTS=stripe)', () => {
  it('gives every ticket order a fresh payment_id and leaves other orders alone', async () => {
    const data = loadSeedData();
    const ticketOrders = new Set(data.tickets.map((tk) => tk.order_id));
    let n = 0;
    const seen: string[] = [];
    await seedDatabase(t().db, {
      createPayment: async (order) => {
        seen.push(order._id);
        return `pi_test_${++n}`;
      },
    });

    expect(new Set(seen)).toEqual(ticketOrders);
    const orders = await t().db.collection<OrderDoc>(COLLECTIONS.orders).find().toArray();
    for (const o of orders) {
      if (ticketOrders.has(o._id)) expect(o.payment_id).toMatch(/^pi_test_\d+$/);
      else expect(o.payment_id).toBe(data.orders.find((d) => d._id === o._id)!.payment_id);
    }

    // A reset makes new payments again, so a second rehearsal refunds new payments.
    const before = new Map(orders.map((o) => [o._id, o.payment_id]));
    await resetDatabase(t().db, { createPayment: async () => `pi_test_${++n}` });
    const after = await t().db.collection<OrderDoc>(COLLECTIONS.orders).find({ _id: { $in: [...ticketOrders] } }).toArray();
    expect(after.every((o) => o.payment_id !== before.get(o._id))).toBe(true);
  });

  it('is off unless PAYMENTS=stripe, and needs a test key when on', () => {
    expect(seedPaymentHook({})).toBeUndefined();
    expect(seedPaymentHook({ PAYMENTS: 'fake-http' })).toBeUndefined();
    expect(() => seedPaymentHook({ PAYMENTS: 'stripe' })).toThrow(/STRIPE_SECRET_KEY/);
    expect(typeof seedPaymentHook({ PAYMENTS: 'stripe', STRIPE_SECRET_KEY: 'sk_test_x' })).toBe('function');
  });
});

describe('reset clears the fake provider (FAKE_PROVIDER_URL)', () => {
  it('clears refunds and the call log, so a rehearsal does not replay the last one', async () => {
    const { server, url, provider } = await startFakeProviderServer();
    try {
      await provider.refund({ paymentRef: 'pi_1', amountCents: 100, currency: 'usd', idempotencyKey: 'k1' });
      expect(await clearFakeProvider({ FAKE_PROVIDER_URL: url })).toBe('cleared');
      expect(provider.calls).toHaveLength(0);
    } finally {
      server.close();
    }
    expect(await clearFakeProvider({})).toBe('not configured');
    expect(await clearFakeProvider({ FAKE_PROVIDER_URL: 'http://127.0.0.1:1' })).toMatch(/^not reachable/);
  });
});
