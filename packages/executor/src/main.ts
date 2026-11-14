import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MongoClient } from "mongodb";
import { ConfigError, loadConfig, type ExecutorConfig } from "./config.js";
import { Crasher } from "./crash.js";
import { Executor } from "./executor.js";
import { FakeProvider } from "./providers/fake.js";
import { HttpFakeProvider } from "./providers/fake-http.js";
import { StripeProvider } from "./providers/stripe.js";
import type { PaymentProvider } from "./providers/types.js";

// npm workspace scripts run from packages/executor; the .env lives at the repo root.
for (const candidate of [".env", "../../.env"]) {
  const path = resolve(process.cwd(), candidate);
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}

function makeProvider(config: ExecutorConfig): PaymentProvider {
  switch (config.payments) {
    case "stripe":
      return new StripeProvider(config.stripeSecretKey!);
    case "fake-http":
      return new HttpFakeProvider(config.fakeProviderUrl!);
    case "fake":
      console.warn("[executor] PAYMENTS=fake keeps refunds in memory; use fake-http to survive restarts.");
      return new FakeProvider();
  }
}

let config: ExecutorConfig;
let crasher: Crasher;
try {
  config = loadConfig();
  crasher = Crasher.fromEnv();
} catch (err) {
  if (err instanceof ConfigError || err instanceof Error) {
    console.error(`[executor] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

const client = new MongoClient(config.mongoUri, { appName: "escrowops-executor" });
await client.connect();
const executor = new Executor({ db: client.db(config.dbName), provider: makeProvider(config), crasher });

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[executor] ${signal}, finishing current payout and stopping`);
  await executor.stop();
  await client.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

if (crasher.armed) console.log(`[executor] chaos mode: CRASH_AT=${process.env.CRASH_AT} CRASH_ON_HIT=${process.env.CRASH_ON_HIT ?? 1}`);
await executor.start();
