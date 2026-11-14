/**
 * A7 precedent-deviation guard.
 *
 * Rule: take the 3 past disputes most similar to the ticket that ended in a refund (full or
 * partial; declined precedents decide eligibility, not amounts). The precedent ceiling is
 * 2x the largest of their refunds. A proposed amount above the ceiling deviates from precedent
 * and is not paid automatically, whatever the auto cap says. With no comparable precedent
 * there is no ceiling (null) and the guard does not apply.
 *
 * Computed from the ticket's own text, never from the model's search query, so the agent
 * cannot steer it. Enforced in three places: the agent tool layer records it on the proposal,
 * the `intents` validator refuses an amount above the recorded ceiling (so the proposal lands
 * in review_queue), and the executor recomputes it before paying an intent.
 */
import type { Db } from 'mongodb';
import { searchPrecedents, type PrecedentHit, type SearchOptions } from './embed.js';
import type { PrecedentCheck, PrecedentRef, TicketDoc } from './types.js';

export const PRECEDENT_MULTIPLIER = 2;
export const PRECEDENT_BASIS_SIZE = 3;

/** The text a ticket is compared with precedents by. */
export const ticketQuery = (t: Pick<TicketDoc, 'subject' | 'body'>) => `${t.subject}\n${t.body}`;

export const precedentRef = (h: Pick<PrecedentHit, 'precedent_id' | 'score' | 'refund_cents' | 'outcome'>): PrecedentRef => ({
  precedent_id: h.precedent_id,
  score: h.score,
  refund_cents: h.refund_cents,
  outcome: h.outcome,
});

/** Pure: the ceiling from a similarity-ordered list of hits. */
export function ceilingFrom(hits: PrecedentHit[], method: string): PrecedentCheck {
  const basis = hits.filter((h) => h.outcome !== 'declined').slice(0, PRECEDENT_BASIS_SIZE);
  return {
    ceiling_cents: basis.length ? PRECEDENT_MULTIPLIER * Math.max(...basis.map((h) => h.refund_cents)) : null,
    multiplier: PRECEDENT_MULTIPLIER,
    basis: basis.map(precedentRef),
    method,
  };
}

/** Searches precedents for the ticket and returns the ceiling, plus the raw hits (for scores). */
export async function precedentCheck(
  db: Db,
  ticket: Pick<TicketDoc, 'subject' | 'body'>,
  opts: SearchOptions = {},
): Promise<{ check: PrecedentCheck; hits: PrecedentHit[] }> {
  // Enough candidates that 3 refunded ones remain after dropping declined precedents.
  const res = await searchPrecedents(db, ticketQuery(ticket), 10, opts);
  const method = `${res.method}:${res.model}`;
  return { check: ceilingFrom(res.hits, method), hits: res.hits };
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Why `amountCents` deviates from `check`, or undefined when it does not. */
export function precedentDeviation(amountCents: number, check: PrecedentCheck | undefined): string | undefined {
  if (!check || check.ceiling_cents === null || amountCents <= check.ceiling_cents) return undefined;
  const top = check.basis.reduce((a, b) => ((b.refund_cents ?? 0) > (a.refund_cents ?? 0) ? b : a), check.basis[0]!);
  return (
    `precedent_deviation: ${dollars(amountCents)} is more than ${check.multiplier}x the largest refund ` +
    `(${dollars(top.refund_cents ?? 0)}, ${top.precedent_id}) among the ${check.basis.length} most similar resolved disputes ` +
    `(${check.basis.map((b) => b.precedent_id).join(', ')}); ceiling ${dollars(check.ceiling_cents)}`
  );
}
