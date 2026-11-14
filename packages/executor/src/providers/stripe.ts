import Stripe from "stripe";
import {
  PermanentProviderError,
  TransientProviderError,
  type PaymentProvider,
  type RefundRequest,
  type RefundResult,
} from "./types.js";

const TRANSIENT_TYPES = new Set(["StripeConnectionError", "StripeAPIError", "StripeRateLimitError"]);

export class StripeProvider implements PaymentProvider {
  readonly name = "stripe";
  private readonly stripe: Stripe;

  constructor(secretKey: string) {
    // The SDK's own network retries reuse the idempotency key, which is safe.
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2 });
  }

  async refund(req: RefundRequest): Promise<RefundResult> {
    const target = req.paymentRef.startsWith("ch_")
      ? { charge: req.paymentRef }
      : { payment_intent: req.paymentRef };
    try {
      const refund = await this.stripe.refunds.create(
        { ...target, amount: req.amountCents, metadata: req.metadata },
        { idempotencyKey: req.idempotencyKey },
      );
      return { refundId: refund.id };
    } catch (err) {
      const e = err as { type?: string; statusCode?: number; message?: string };
      const message = `stripe: ${e.message ?? String(err)}`;
      if ((e.type && TRANSIENT_TYPES.has(e.type)) || (e.statusCode ?? 0) >= 500 || e.statusCode === 409) {
        // 409 is Stripe's "a request with this key is still in flight".
        throw new TransientProviderError(message);
      }
      throw new PermanentProviderError(message);
    }
  }
}
