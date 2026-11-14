/**
 * Kill switch UI: a FROZEN banner and a Freeze / Unfreeze control.
 *
 * The dashboard stays read-only: the button posts to /api/freeze, which the dashboard server
 * forwards to the approval service. There an authenticated approver triggers an admin-path
 * `updateRole` that removes the agent's insert on intents and review_queue, and every unpaid
 * intent is voided. State shown here comes from the `kill_switch` collection via the live feed.
 */
import { useState } from 'react';
import { dollars } from './api.js';
import type { FreezeSummary } from '../src/types.js';
import './kill-switch.css';

async function post(path: '/api/freeze' | '/api/unfreeze', reason: string): Promise<void> {
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
        Agent frozen by <b>{freeze.actor}</b> at {new Date(freeze.at).toLocaleTimeString()}: {freeze.reason}. MongoDB revoked its
        insert on <code>intents</code> and <code>review_queue</code>; its next write fails with code 13.
      </span>
      <span className="freeze-voided" data-testid="frozen-voided">
        {freeze.voided.length} unpaid refund{freeze.voided.length === 1 ? '' : 's'} voided ({dollars(total)})
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
      await post(frozen ? '/api/unfreeze' : '/api/freeze', reason);
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
        title={frozen ? 'Restore the agent role to its definition' : 'Revoke the agent role\'s write privileges in MongoDB'}
      >
        {busy ? '…' : frozen ? 'Unfreeze agent' : 'Freeze agent'}
      </button>
      {error && <span className="error" role="alert">{error}</span>}
    </span>
  );
}
