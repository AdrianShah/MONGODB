/**
 * Executor-only settings. The database connection comes from the shared
 * config (MONGODB_URI, MONGODB_DB, EXECUTOR_DB_USER / EXECUTOR_DB_PASSWORD).
 *
 *   PAYMENTS           stripe | fake | fake-http (default "stripe")
 *   STRIPE_SECRET_KEY  required when PAYMENTS=stripe; must be a test-mode key
 *   FAKE_PROVIDER_URL  required when PAYMENTS=fake-http
 *
 * Every failure names the variable (TEST_PLAN O5).
 */
import { MissingEnvError, requireEnv, type Env } from '@escrowops/shared';

export type PaymentsMode = 'stripe' | 'fake' | 'fake-http';

export interface PaymentsConfig {
  payments: PaymentsMode;
  stripeSecretKey?: string;
  fakeProviderUrl?: string;
}

/** A variable is set but its value is wrong. */
export class InvalidEnvError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = 'InvalidEnvError';
    this.variable = variable;
  }
}

export function loadPaymentsConfig(env: Env = process.env): PaymentsConfig {
  const payments = (env['PAYMENTS']?.trim() || 'stripe') as PaymentsMode;
  if (!['stripe', 'fake', 'fake-http'].includes(payments)) {
    throw new InvalidEnvError('PAYMENTS', `must be "stripe", "fake" or "fake-http" (got "${env['PAYMENTS']}")`);
  }

  if (payments === 'stripe') {
    const key = requireEnv(env, 'STRIPE_SECRET_KEY', 'Required when PAYMENTS=stripe (or set PAYMENTS=fake-http)');
    if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
      throw new InvalidEnvError('STRIPE_SECRET_KEY', 'must be a test-mode key (sk_test_... or rk_test_...)');
    }
    return { payments, stripeSecretKey: key };
  }
  if (payments === 'fake-http') {
    return { payments, fakeProviderUrl: requireEnv(env, 'FAKE_PROVIDER_URL', 'Required when PAYMENTS=fake-http') };
  }
  return { payments };
}

export { MissingEnvError };
