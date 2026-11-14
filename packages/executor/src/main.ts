/**
 * Executor process: `npm run executor` from the repo root.
 * Connects as the executor database user (EXECUTOR_DB_USER) and nothing else.
 */
import { hostname } from 'node:os';
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
// demo:kill: crash on the next payout, after the provider call and before the ledger update.
process.on('SIGUSR2', () => {
  crasher.arm(3);
  console.log('[executor] demo: armed to crash after the next provider call, before the ledger update');
});

if (crasher.armed) {
  console.log(`[executor] chaos mode: CRASH_AT=${process.env['CRASH_AT']} CRASH_ON_HIT=${process.env['CRASH_ON_HIT'] ?? 1}`);
}
await executor.start();
// Lets `npm run demo:kill` find this process. Refreshed every few seconds, because
// `npm run reset` clears executor_state while the executor keeps running.
const startedAt = new Date();
const register = () =>
  client
    .db(config.dbName)
    .collection<{ _id: string }>('executor_state')
    .updateOne(
      { _id: 'process' },
      { $set: { pid: process.pid, host: hostname(), instance: executor.instanceId, started_at: startedAt, seen_at: new Date() } },
      { upsert: true },
    )
    .catch(() => {});
await register();
setInterval(() => void register(), 3000).unref();
