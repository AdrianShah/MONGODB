/**
 * Payment-provider side of `npm run seed` and `npm run reset` (T2, T4): a repeat
 * rehearsal must create new refunds, never replay the previous run's.
 */
import type { Env, OrderDoc } from '@escrowops/shared';
import { HttpFakeProvider, StripeProvider, loadPaymentsConfig } from '@escrowops/executor';

/**
 * With PAYMENTS=stripe (set explicitly), a function that makes a fresh Stripe test payment
 * per order. Otherwise undefined, and the dataset's fake payment IDs are used.
 */
export function seedPaymentHook(env: Env = process.env): ((order: OrderDoc) => Promise<string>) | undefined {
  if (env['PAYMENTS']?.trim() !== 'stripe') return undefined;
  const stripe = new StripeProvider(loadPaymentsConfig(env).stripeSecretKey!);
  return (order) => stripe.createTestPayment(order);
}

/** When FAKE_PROVIDER_URL is set, clear the fake provider's refunds and call log. */
export async function clearFakeProvider(env: Env = process.env): Promise<'cleared' | 'not configured' | string> {
  const url = env['FAKE_PROVIDER_URL']?.trim();
  if (!url) return 'not configured';
  try {
    await new HttpFakeProvider(url).reset();
    return 'cleared';
  } catch (err) {
    return `not reachable at ${url} (${(err as Error).message}); start it with npm run fake-provider`;
  }
}
