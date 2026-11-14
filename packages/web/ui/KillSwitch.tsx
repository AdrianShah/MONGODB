/**
 * Kill switch UI: a FROZEN banner and a Freeze / Unfreeze control.
 *
 * The dashboard stays read-only: the button posts to /api/agent/freeze, which the dashboard
 * server forwards to the approval service. There an authenticated approver triggers the admin
 * path: an unsatisfiable validator on intents and review_queue (plus updateRole where the server
 * allows it), and every unpaid intent is voided. State shown here comes from the `kill_switch` collection via the live feed.
 */
import { useState } from 'react';
import { dollars } from './api.js';
import type { FreezeSummary } from '../src/types.js';
import './kill-switch.css';

async function post(path: '/api/agent/freeze' | '/api/agent/unfreeze', reason: string): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(reason ? { reason } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(data.message ?? `HTTP ${res.status}`);
  }
}

export function FreezeBanner({ freeze }: { freeze: FreezeSummary | null | undefined }) {
  if (!freeze?.frozen) return null;
  const total = freeze.voided.reduce((s, v) => s + v.amount_cents, 0);
  return (
    <div className="freeze-banner" role="alert" data-testid="frozen-banner">
      <strong>FROZEN</strong>
      <span>
        Agent frozen by <b>{freeze.actor}</b> at {new Date(freeze.at).toLocaleTimeString()}: {freeze.reason}. MongoDB now rejects every
        insert into <code>intents</code> and <code>review_queue</code>; the agent's next write fails with code{' '}
        {freeze.role_revoked ? '13 (Unauthorized)' : '121 (DocumentValidationFailure)'}.
      </span>
      <span className="freeze-voided" data-testid="frozen-voided">
        {freeze.voided.length} unpaid refund{freeze.voided.length === 1 ? '' : 's'} voided ({dollars(total)})
        {freeze.voided_reviews ? `; ${freeze.voided_reviews} pending review${freeze.voided_reviews === 1 ? '' : 's'} rejected` : ''}
        {freeze.in_flight.length > 0 ? `; ${freeze.in_flight.length} already in flight` : ''}
      </span>
    </div>
  );
}

export function FreezeControl({ freeze, me }: { freeze: FreezeSummary | null | undefined; me: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!me) return null; // Approvers only; the approval service checks the session again.
  const frozen = !!freeze?.frozen;

  const act = async () => {
    setError('');
    let reason = '';
    if (!frozen) {
      const answer = window.prompt('Freeze the agent? Its database writes stop and unpaid refunds are voided. Reason:', 'stop the agent mid-run');
      if (answer === null) return;
      reason = answer.trim();
    }
    setBusy(true);
    try {
      await post(frozen ? '/api/agent/unfreeze' : '/api/agent/freeze', reason);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="freeze-control">
      <button
        className={frozen ? 'unfreeze' : 'freeze'}
        onClick={act}
        disabled={busy}
        data-testid={frozen ? 'unfreeze-agent' : 'freeze-agent'}
        title={frozen ? 'Restore the validators and the agent role' : 'Make MongoDB reject every new proposal from the agent'}
      >
        {busy ? '…' : frozen ? 'Unfreeze agent' : 'Freeze agent'}
      </button>
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}
