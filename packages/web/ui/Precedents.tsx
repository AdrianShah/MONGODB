/** A7: the past disputes a held refund was checked against, and why it was held. */
import type { ReviewCard } from './api.js';
import { dollars } from './api.js';

export function Precedents({ review }: { review: ReviewCard }) {
  const check = review.precedent_check;
  const cited = new Set((review.precedents_cited ?? []).map((p) => p.precedent_id));
  if (!check && !review.hold_reasons?.length) return null;
  return (
    <div className="precedents" data-testid="precedents" style={{ marginTop: 6, fontSize: '0.78rem' }}>
      {review.hold_reasons?.map((r, i) => (
        <p key={i} className="small rule" data-testid="hold-reason">
          {r}
        </p>
      ))}
      {check && (
        <>
          <p className="small muted" style={{ margin: '2px 0' }}>
            Precedents ({check.method.replace(':', ' · ')}) · ceiling{' '}
            {check.ceiling_cents === null ? 'none' : dollars(check.ceiling_cents)}
          </p>
          <ul className="evidence">
            {check.basis.map((p) => (
              <li key={p.precedent_id}>
                <span className="ev-kind">{p.precedent_id}</span> {p.outcome ?? ''}{' '}
                {p.refund_cents === null ? '' : dollars(p.refund_cents)}
                {p.score === null ? '' : ` · sim ${p.score.toFixed(3)}`}
                {cited.has(p.precedent_id) ? ' · cited by agent' : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
