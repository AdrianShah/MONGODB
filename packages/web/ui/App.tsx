import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ApiError,
  api,
  dollars,
  subscribePipeline,
  type BudgetSummary,
  type FeedStatus,
  type ReviewCard,
  type Stage,
  type TicketCard,
  type TimelineEvent,
  type TimelineIntegrity,
} from './api.js';

const COLUMNS: Array<{ id: string; title: string; hint: string; stages: Stage[] }> = [
  { id: 'intake', title: 'Intake', hint: 'Waiting for or being worked by the agent', stages: ['open', 'working'] },
  { id: 'auto', title: 'Auto-approved', hint: 'Within the $500 cap; the validator accepted it', stages: ['proposed'] },
  { id: 'held', title: 'Held for review', hint: 'The validator refused it as an auto refund', stages: ['held'] },
  { id: 'approved', title: 'Approved', hint: 'Promoted by humans; executor is paying', stages: ['approved', 'paying'] },
  { id: 'paid', title: 'Paid', hint: 'Refund issued exactly once', stages: ['paid'] },
  { id: 'stopped', title: 'Stopped', hint: 'Declined, rejected, blocked or failed', stages: ['declined', 'rejected', 'blocked', 'failed', 'error'] },
];

const STAGE_LABEL: Record<Stage, string> = {
  open: 'Open',
  working: 'Agent working',
  proposed: 'Auto-approved',
  held: 'Held',
  approved: 'Approved',
  paying: 'Paying',
  paid: 'Paid',
  declined: 'Declined',
  rejected: 'Rejected',
  blocked: 'Blocked',
  failed: 'Payout failed',
  error: 'Agent error',
};

const TIER_LABEL: Record<string, string> = {
  single_agent: 'Auto',
  peer_review: 'Peer review · 1 approver',
  human_required: 'Dual control · 2 approvers',
  blocked: 'Over the hard cap',
};

export function App() {
  const [tickets, setTickets] = useState<TicketCard[]>([]);
  const [budget, setBudget] = useState<BudgetSummary | null>(null);
  const [feed, setFeed] = useState<FeedStatus>('connecting');
  const [me, setMe] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [requireLogin, setRequireLogin] = useState(true);
  const [traceOpen, setTraceOpen] = useState<TicketCard | null>(null);

  useEffect(() => {
    Promise.all([
      api.config().then((c) => setRequireLogin(c.requireLogin), () => setRequireLogin(true)),
      api.me().then((r) => setMe(r.approver_id), () => setMe(null)),
    ]).finally(() => setChecked(true));
  }, []);

  const locked = requireLogin && !me;
  useEffect(() => {
    if (!checked || locked) {
      setTickets([]);
      setBudget(null);
      return;
    }
    return subscribePipeline((m) => {
      setTickets(m.tickets);
      setBudget(m.budget);
    }, setFeed);
  }, [checked, locked]);

  const totals = useMemo(() => {
    const paid = tickets.filter((t) => t.stage === 'paid');
    return {
      paidCents: paid.reduce((s, t) => s + (t.ledger?.amount_cents ?? 0), 0),
      paid: paid.length,
      held: tickets.filter((t) => t.stage === 'held').length,
      stopped: tickets.filter((t) => COLUMNS[5]!.stages.includes(t.stage)).length,
    };
  }, [tickets]);

  // Keep an open timeline's ticket current as the pipeline changes.
  const openTicket = traceOpen ? (tickets.find((t) => t.ticket_id === traceOpen.ticket_id) ?? traceOpen) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>✓</span>
          <div>
            <h1>EscrowOps</h1>
            <p>The agent proposes. MongoDB decides what pays.</p>
          </div>
        </div>
        <div className="topbar-right">
          {!locked && (
            <span className={`feed feed-${feed}`} data-testid="feed-status">
              <span className="dot" />
              {feed === 'live' ? 'Live' : feed === 'connecting' ? 'Connecting' : 'Reconnecting'}
            </span>
          )}
          <SignIn me={me} onChange={setMe} />
        </div>
      </header>

      {locked ? (
        <main className="locked" data-testid="locked">
          <h2>Sign in to view the pipeline</h2>
          <p className="muted">The dashboard shows refund decisions and customer data, so it is for approvers only. Use the form above.</p>
        </main>
      ) : (
        <>
      <section className="stats" aria-label="Summary">
        <Stat label="Tickets" value={String(tickets.length)} />
        <Stat label="Paid out" value={dollars(totals.paidCents)} sub={`${totals.paid} refunds`} />
        <Stat label="Awaiting approval" value={String(totals.held)} />
        <Stat
          label="Auto budget today"
          value={budget ? `${dollars(budget.spent_cents)}` : '—'}
          sub={budget ? `of ${dollars(budget.cap_cents)}; then refunds go to review` : 'not started today'}
          testId="budget"
        />
      </section>

      <main className="board">
        {COLUMNS.map((col) => {
          const cards = tickets.filter((t) => col.stages.includes(t.stage));
          return (
            <section key={col.id} className={`column column-${col.id}`} data-testid={`column-${col.id}`}>
              <header>
                <h2>{col.title}</h2>
                <span className="count">{cards.length}</span>
              </header>
              <p className="hint">{col.hint}</p>
              <div className="cards">
                {cards.map((t) => (
                  <Ticket key={t.ticket_id} ticket={t} me={me} onOpen={() => setTraceOpen(t)} />
                ))}
              </div>
            </section>
          );
        })}
      </main>
        </>
      )}

      {openTicket && !locked && <Timeline ticket={openTicket} onClose={() => setTraceOpen(null)} />}
    </div>
  );
}

function Stat({ label, value, sub, testId }: { label: string; value: string; sub?: string; testId?: string }) {
  return (
    <div className="stat" data-testid={testId}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </div>
  );
}

function SignIn({ me, onChange }: { me: string | null; onChange: (id: string | null) => void }) {
  const [id, setId] = useState('approver-a');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  if (me) {
    return (
      <div className="signin signed-in">
        <span data-testid="signed-in-as">
          Signed in as <strong>{me}</strong>
        </span>
        <button className="ghost" onClick={() => api.logout().finally(() => onChange(null))}>
          Sign out
        </button>
      </div>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      onChange((await api.login(id, password)).approver_id);
      setPassword('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    }
  };
  return (
    <form className="signin" onSubmit={submit} aria-label="Approver sign-in">
      <select value={id} onChange={(e) => setId(e.target.value)} aria-label="Approver" data-testid="login-approver">
        <option value="approver-a">approver-a</option>
        <option value="approver-b">approver-b</option>
      </select>
      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        aria-label="Password"
        data-testid="login-password"
      />
      <button type="submit" data-testid="login-submit">
        Sign in
      </button>
      {error && <span className="error" role="alert">{error}</span>}
    </form>
  );
}

function Ticket({ ticket, me, onOpen }: { ticket: TicketCard; me: string | null; onOpen: () => void }) {
  const r = ticket.review;
  return (
    <article className={`card stage-${ticket.stage}`} data-testid={`ticket-${ticket.ticket_id}`} data-stage={ticket.stage}>
      <div className="card-head">
        <span className="ticket-id">{ticket.ticket_id}</span>
        <span className={`badge badge-${ticket.stage}`} data-testid="stage">
          {STAGE_LABEL[ticket.stage]}
        </span>
      </div>
      {ticket.blocked_writes?.length ? (
        <p className="injection" data-testid="injection-blocked" title={ticket.blocked_writes.map((b) => `${b.tool}: code ${b.code}`).join('\n')}>
          {`Injection attempt blocked · ${ticket.blocked_writes.length} write${ticket.blocked_writes.length === 1 ? '' : 's'} refused by MongoDB (code ${[...new Set(ticket.blocked_writes.map((b) => b.code))].join(', ')})`}
        </p>
      ) : null}
      <p className="subject">{ticket.subject}</p>
      <div className="meta">
        {ticket.amount_cents !== undefined && <span className="amount">{dollars(ticket.amount_cents)}</span>}
        <span>{ticket.order_id}</span>
      </div>

      {r && ticket.stage === 'held' && <Review review={r} me={me} />}
      {r && ticket.stage !== 'held' && r.approvals.length > 0 && (
        <p className="small">Approved by {r.approvals.filter((a) => a.decision === 'approve').map((a) => a.approver_id).join(', ') || 'nobody'}</p>
      )}
      {ticket.ledger?.status === 'succeeded' && (
        <p className="small refund" data-testid="refund-id">
          {ticket.ledger.provider} refund <code>{ticket.ledger.provider_refund_id}</code>
        </p>
      )}
      {ticket.note && <p className="small note">{ticket.note}</p>}
      {r?.promotion_error && <p className="small note">Refused by the approved validator: {r.promotion_error}</p>}

      {ticket.trace_id && (
        <button className="link" onClick={onOpen} data-testid="open-timeline">
          Audit timeline →
        </button>
      )}
    </article>
  );
}

function Review({ review, me }: { review: ReviewCard; me: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mine = me ? review.approvals.find((a) => a.approver_id === me) : undefined;
  const disabled = !me || !!mine || busy || review.status !== 'pending';

  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true);
    setError('');
    try {
      await api.decide(review.id, action);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review" data-testid="review">
      <div className="review-row">
        <span className="tier">{TIER_LABEL[review.tier] ?? review.tier}</span>
        <span className="progress" data-testid="progress">
          {review.approved_count} of {review.required_approvals}
        </span>
      </div>
      <div className="meter" aria-hidden>
        <span style={{ width: `${Math.min(100, (review.approved_count / Math.max(1, review.required_approvals)) * 100)}%` }} />
      </div>
      {review.rules_broken.length > 0 && (
        <p className="small rule" data-testid="rule">
          Validator rule broken: <code>{review.rules_broken.join(', ')}</code>
        </p>
      )}
      <p className="reason" data-testid="reason">{review.reason}</p>
      {review.evidence.length > 0 && (
        <ul className="evidence" data-testid="evidence">
          {review.evidence.map((e, i) => (
            <li key={i}>
              <span className="ev-kind">{e.kind}</span> {e.ref} {e.note ? `· ${e.note}` : ''}
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button className="approve" disabled={disabled} onClick={() => decide('approve')} data-testid="approve">
          Approve
        </button>
        <button className="reject" disabled={disabled} onClick={() => decide('reject')} data-testid="reject">
          Reject
        </button>
      </div>
      <p className="small muted">
        {!me ? 'Sign in to decide.' : mine ? `You ${mine.decision === 'approve' ? 'approved' : 'rejected'} this.` : ''}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function Timeline({ ticket, onClose }: { ticket: TicketCard; onClose: () => void }) {
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [integrity, setIntegrity] = useState<TimelineIntegrity | undefined>();
  const [error, setError] = useState('');
  // Reload whenever the ticket moves, so the timeline stays live while open.
  const version = `${ticket.trace_id}|${ticket.stage}|${ticket.review?.approved_count ?? 0}|${ticket.ledger?.status ?? ''}`;
  useEffect(() => {
    if (!ticket.trace_id) return;
    api.timeline(ticket.trace_id).then(
      (r) => {
        setEvents(r.events);
        setIntegrity(r.integrity);
      },
      (e) => setError(String(e)),
    );
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Audit timeline" data-testid="timeline">
        <header>
          <div>
            <h2>Audit timeline · {ticket.ticket_id}</h2>
            <p className="small muted">
              One <code>$unionWith</code> aggregation over trace <code>{ticket.trace_id}</code>
            </p>
          </div>
          <button className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {integrity && (
          <p className={`integrity ${integrity.ok ? 'ok' : 'broken'}`} data-testid="integrity">
            {integrity.ok
              ? `✓ Hash chain verified: ${integrity.checked} records unchanged since they were written`
              : `✗ Tampering detected: ${integrity.problems.join('; ')}`}
          </p>
        )}
        {error && <p className="error">{error}</p>}
        {!events && !error && <p className="muted">Loading…</p>}
        <ol className="events">
          {events?.map((e, i) => (
            <li key={i} className={`event src-${e.source}`} data-testid="timeline-event" data-source={e.source} data-kind={e.kind}>
              <time>{new Date(e.at).toLocaleTimeString()}</time>
              <span className="src">{e.source}</span>
              <span className="what">{e.summary}</span>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
