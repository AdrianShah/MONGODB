/** TEST_PLAN O5 for the executor's own settings, and the CRASH_AT parser. */
import { describe, expect, it } from 'vitest';
import { MissingEnvError } from '@escrowops/shared';
import { Crasher, InvalidEnvError, loadPaymentsConfig } from '@escrowops/executor';

describe('executor settings name the variable on failure', () => {
  it('defaults to stripe and requires STRIPE_SECRET_KEY', () => {
    expect(() => loadPaymentsConfig({})).toThrow(MissingEnvError);
    expect(() => loadPaymentsConfig({})).toThrow(/STRIPE_SECRET_KEY/);
  });
  it('refuses a live Stripe key', () => {
    expect(() => loadPaymentsConfig({ STRIPE_SECRET_KEY: 'sk_live_abc' })).toThrow(InvalidEnvError);
    expect(loadPaymentsConfig({ STRIPE_SECRET_KEY: 'sk_test_abc' }).stripeSecretKey).toBe('sk_test_abc');
  });
  it('rejects an unknown PAYMENTS value', () => {
    expect(() => loadPaymentsConfig({ PAYMENTS: 'paypal' })).toThrow(/PAYMENTS/);
  });
  it('requires FAKE_PROVIDER_URL for fake-http', () => {
    expect(() => loadPaymentsConfig({ PAYMENTS: 'fake-http' })).toThrow(/FAKE_PROVIDER_URL/);
    expect(loadPaymentsConfig({ PAYMENTS: 'fake' })).toEqual({ payments: 'fake' });
  });
  it('validates CRASH_AT', () => {
    expect(() => Crasher.fromEnv({ CRASH_AT: '7' })).toThrow(/CRASH_AT/);
    expect(Crasher.fromEnv({}).armed).toBe(false);
    expect(Crasher.fromEnv({ CRASH_AT: '3' }).armed).toBe(true);
  });
});
