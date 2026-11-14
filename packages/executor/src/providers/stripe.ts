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

  /**
   * Seed helper (T2): a fresh, confirmed test-mode payment for an order, so refunds have
   * something real to go against. Money already refunded on the order is refunded here too,
   * so Stripe's refundable balance matches the order's. Returns the PaymentIntent ID.
   */
  async createTestPayment(order: { _id: string; amount_cents: number; refunded_cents?: number }): Promise<string> {
    const intent = await this.stripe.paymentIntents.create({
      amount: order.amount_cents,
      currency: 'usd',
      payment_method: 'pm_card_visa',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { order_id: order._id, source: 'escrowops-seed' },
    });
    if (order.refunded_cents && order.refunded_cents > 0) {
      await this.stripe.refunds.create({ payment_intent: intent.id, amount: order.refunded_cents, metadata: { source: 'escrowops-seed' } });
    }
    return intent.id;
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
