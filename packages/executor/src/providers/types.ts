export interface RefundRequest {
  /** The Stripe PaymentIntent (or charge) to refund against. */
  paymentRef: string;
  amountCents: number;
  currency: string;
  /** Same key on every attempt for one ledger entry, so a retry never pays twice. */
  idempotencyKey: string;
  metadata?: Record<string, string>;
}

export interface RefundResult {
  refundId: string;
}

/** Retry with the same idempotency key (network error, 5xx, rate limit). */
export class TransientProviderError extends Error {
  readonly transient = true;
}

/** Do not retry; record the refund as failed (bad request, card error, ...). */
export class PermanentProviderError extends Error {
  readonly transient = false;
}

export interface PaymentProvider {
  readonly name: string;
  /** Must be idempotent on `idempotencyKey`: a repeat returns the original result. */
  refund(req: RefundRequest): Promise<RefundResult>;
}
