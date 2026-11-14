export type PaymentsMode = "stripe" | "fake" | "fake-http";

export interface ExecutorConfig {
  mongoUri: string;
  dbName: string;
  payments: PaymentsMode;
  stripeSecretKey?: string;
  fakeProviderUrl?: string;
}

export class ConfigError extends Error {}

/**
 * Reads the executor's environment. Every failure names the variable (TEST_PLAN O5).
 *
 *   EXECUTOR_MONGODB_URI  connection string for the executor database user (required)
 *   MONGODB_DB            database name (default "escrowops")
 *   PAYMENTS              stripe | fake | fake-http (default "stripe")
 *   STRIPE_SECRET_KEY     required when PAYMENTS=stripe; must be a test-mode key
 *   FAKE_PROVIDER_URL     required when PAYMENTS=fake-http
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  const mongoUri = env.EXECUTOR_MONGODB_URI?.trim();
  if (!mongoUri) {
    throw new ConfigError("EXECUTOR_MONGODB_URI is not set. It should be the connection string for the executor database user.");
  }

  const payments = (env.PAYMENTS?.trim() || "stripe") as PaymentsMode;
  if (!["stripe", "fake", "fake-http"].includes(payments)) {
    throw new ConfigError(`PAYMENTS must be "stripe", "fake" or "fake-http" (got "${env.PAYMENTS}").`);
  }

  const config: ExecutorConfig = {
    mongoUri,
    dbName: env.MONGODB_DB?.trim() || "escrowops",
    payments,
  };

  if (payments === "stripe") {
    const key = env.STRIPE_SECRET_KEY?.trim();
    if (!key) throw new ConfigError("STRIPE_SECRET_KEY is not set (required when PAYMENTS=stripe).");
    if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
      throw new ConfigError("STRIPE_SECRET_KEY must be a test-mode key (sk_test_... or rk_test_...).");
    }
    config.stripeSecretKey = key;
  }

  if (payments === "fake-http") {
    const url = env.FAKE_PROVIDER_URL?.trim();
    if (!url) throw new ConfigError("FAKE_PROVIDER_URL is not set (required when PAYMENTS=fake-http).");
    config.fakeProviderUrl = url;
  }

  return config;
}
