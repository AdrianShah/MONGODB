import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { Crasher } from "../src/crash.js";

describe("O5: missing or wrong environment variables name the variable", () => {
  const base = { EXECUTOR_MONGODB_URI: "mongodb://x", PAYMENTS: "fake" };

  it("requires EXECUTOR_MONGODB_URI", () => {
    expect(() => loadConfig({})).toThrow(/EXECUTOR_MONGODB_URI/);
  });
  it("rejects an unknown PAYMENTS value", () => {
    expect(() => loadConfig({ ...base, PAYMENTS: "paypal" })).toThrow(/PAYMENTS/);
  });
  it("requires STRIPE_SECRET_KEY for stripe and refuses a live key", () => {
    expect(() => loadConfig({ ...base, PAYMENTS: "stripe" })).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => loadConfig({ ...base, PAYMENTS: "stripe", STRIPE_SECRET_KEY: "sk_live_abc" })).toThrow(/test-mode/);
  });
  it("requires FAKE_PROVIDER_URL for fake-http", () => {
    expect(() => loadConfig({ ...base, PAYMENTS: "fake-http" })).toThrow(ConfigError);
  });
  it("defaults the database name", () => {
    expect(loadConfig(base).dbName).toBe("escrowops");
  });
  it("validates CRASH_AT", () => {
    expect(() => Crasher.fromEnv({ CRASH_AT: "7" })).toThrow(/CRASH_AT/);
    expect(Crasher.fromEnv({}).armed).toBe(false);
    expect(Crasher.fromEnv({ CRASH_AT: "3" }).armed).toBe(true);
  });
});
