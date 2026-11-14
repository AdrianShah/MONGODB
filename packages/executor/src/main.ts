/**
 * Executor process: `npm run executor` from the repo root.
 * Connects as the executor database user (EXECUTOR_DB_USER) and nothing else.
 */
import { MissingEnvError, connectAs, loadConfigOrExit } from '@escrowops/shared';
import { InvalidEnvError, loadPaymentsConfig, type PaymentsConfig } from './config.js';
import { Crasher } from './crash.js';
import { Executor } from './executor.js';
import { FakeProvider } from './providers/fake.js';
import { HttpFakeProvider } from './providers/fake-http.js';
import { StripeProvider } from './providers/stripe.js';
import type { PaymentProvider } from './providers/types.js';

function makeProvider(payments: PaymentsConfig): PaymentProvider {
  switch (payments.payments) {
    case 'stripe':
      return new StripeProvider(payments.stripeSecretKey!);
    case 'fake-http':
      return new HttpFakeProvider(payments.fakeProviderUrl!);
    case 'fake':
      console.warn('[executor] PAYMENTS=fake keeps refunds in memory; use fake-http to survive restarts.');
      return new FakeProvider();
  }
}

const config = loadConfigOrExit(); // Loads .env; exits naming any missing variable.
let payments: PaymentsConfig;
let crasher: Crasher;
try {
  payments = loadPaymentsConfig();
  crasher = Crasher.fromEnv();
} catch (err) {
  if (err instanceof MissingEnvError || err instanceof InvalidEnvError || err instanceof Error) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const client = await connectAs('executor', config);
const executor = new Executor({ db: client.db(config.dbName), provider: makeProvider(payments), crasher });

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[executor] ${signal}, finishing current payout and stopping`);
  await executor.stop();
  await client.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

if (crasher.armed) {
  console.log(`[executor] chaos mode: CRASH_AT=${process.env['CRASH_AT']} CRASH_ON_HIT=${process.env['CRASH_ON_HIT'] ?? 1}`);
}
await executor.start();
