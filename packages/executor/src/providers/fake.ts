import { randomBytes } from "node:crypto";
import {
  PermanentProviderError,
  TransientProviderError,
  type PaymentProvider,
  type RefundRequest,
  type RefundResult,
} from "./types.js";

export interface FakeCall {
  at: number;
  request: RefundRequest;
  /** "created" for a new refund, "replayed" for a repeated key, "error" otherwise. */
  outcome: "created" | "replayed" | "error";
  refundId?: string;
  error?: string;
}

/**
 * In-memory provider that behaves like Stripe's idempotency: a repeated key
 * returns the original refund, a repeated key with different parameters is
 * an error. Every call is logged, so "exactly once" is an assertion on the log.
 */
export class FakeProvider implements PaymentProvider {
  readonly name = "fake";
  readonly calls: FakeCall[] = [];
  private readonly byKey = new Map<string, { request: RefundRequest; result: RefundResult }>();
  private transientFailures = 0;
  private permanentFailure: string | undefined;

  /** The next `n` calls throw a transient error before doing anything. */
  failTransiently(n: number): void {
    this.transientFailures = n;
  }

  /** Every later call throws a permanent error with this message. */
  failPermanently(message: string): void {
    this.permanentFailure = message;
  }

  async refund(request: RefundRequest): Promise<RefundResult> {
    const at = Date.now();
    if (this.transientFailures > 0) {
      this.transientFailures -= 1;
      this.calls.push({ at, request, outcome: "error", error: "transient" });
      throw new TransientProviderError("fake: simulated transient failure");
    }
    if (this.permanentFailure) {
      this.calls.push({ at, request, outcome: "error", error: this.permanentFailure });
      throw new PermanentProviderError(`fake: ${this.permanentFailure}`);
    }

    const existing = this.byKey.get(request.idempotencyKey);
    if (existing) {
      if (
        existing.request.amountCents !== request.amountCents ||
        existing.request.paymentRef !== request.paymentRef
      ) {
        this.calls.push({ at, request, outcome: "error", error: "idempotency_mismatch" });
        throw new PermanentProviderError("fake: idempotency key reused with different parameters");
      }
      this.calls.push({ at, request, outcome: "replayed", refundId: existing.result.refundId });
      return existing.result;
    }

    const result = { refundId: `re_fake_${randomBytes(8).toString("hex")}` };
    this.byKey.set(request.idempotencyKey, { request, result });
    this.calls.push({ at, request, outcome: "created", refundId: result.refundId });
    return result;
  }

  /** Refunds actually created (one per distinct idempotency key). */
  get created(): FakeCall[] {
    return this.calls.filter((c) => c.outcome === "created");
  }

  reset(): void {
    this.calls.length = 0;
    this.byKey.clear();
    this.transientFailures = 0;
    this.permanentFailure = undefined;
  }
}
