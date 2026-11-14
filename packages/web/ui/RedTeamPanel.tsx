/**
 * "Run red team": POST /api/redteam/run streams the five demo attacks (run with the agent's
 * own credentials) as Server-Sent Events; each row appears as the server refuses it, with
 * the real MongoDB error code.
 */
import { useState } from 'react';
import type { AttackResult, RedTeamAttackInfo, RedTeamStreamEvent, RedTeamSummary } from '@escrowops/shared/redteam-events';
import './RedTeamPanel.css';

interface Row extends RedTeamAttackInfo {
  status: 'queued' | 'running' | 'done';
  result?: AttackResult;
}

type Phase = 'idle' | 'running' | 'done' | 'error';

async function* readSse(res: Response): AsyncGenerator<RedTeamStreamEvent> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut: number;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (data) yield JSON.parse(data.slice(6)) as RedTeamStreamEvent;
    }
  }
}

export function RedTeamPanel() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [identity, setIdentity] = useState<string>('');
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<RedTeamSummary | null>(null);
  const [error, setError] = useState<string>('');

  const update = (index: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const run = async () => {
    setPhase('running');
    setRows([]);
    setSummary(null);
    setError('');
    setIdentity('');
    try {
      const res = await fetch('/api/redteam/run', { method: 'POST', credentials: 'same-origin' });
      if (!res.ok || !(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      for await (const e of readSse(res)) {
        if (e.type === 'start') {
          setIdentity(e.username);
          setRows(e.attacks.map((a) => ({ ...a, status: 'queued' })));
        } else if (e.type === 'attempt') update(e.index, { status: 'running' });
        else if (e.type === 'result') update(e.index, { status: 'done', result: e.result });
        else if (e.type === 'summary') setSummary(e.summary);
        else if (e.type === 'error') throw new Error(e.message);
      }
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  return (
    <section className="redteam" data-testid="redteam-panel" aria-label="Red team">
      <header className="redteam-head">
        <div>
          <h2>Red team</h2>
          <p className="hint">Assume the agent is fully compromised: replay five attacks with its own database credentials.</p>
        </div>
        <button className="redteam-run" onClick={() => void run()} disabled={phase === 'running'} data-testid="redteam-run">
          {phase === 'running' ? 'Attacking...' : 'Run red team'}
        </button>
      </header>

      {identity && (
        <p className="redteam-identity">
          Connected as <code>{identity}</code> (agent credentials only)
        </p>
      )}

      {rows.length > 0 && (
        <ol className="redteam-rows">
          {rows.map((r) => (
            <li key={r.id} className={`redteam-row redteam-${r.status}`} data-testid={`redteam-row-${r.id}`}>
              <div className="redteam-what">
                <strong>{r.label}</strong>
                <span className="redteam-tried">{r.tried}</span>
                {r.result?.errmsg && <span className="redteam-errmsg">{r.result.errmsg}</span>}
              </div>
              <div className="redteam-verdict">
                {r.status !== 'done' || !r.result ? (
                  <span className="redteam-badge pending">{r.status === 'running' ? 'trying' : 'queued'}</span>
                ) : r.result.denied ? (
                  <>
                    <span className="redteam-badge denied">DENIED</span>
                    <code className="redteam-code" title={r.result.message}>
                      {r.result.code} {r.result.codeName}
                    </code>
                  </>
                ) : (
                  <span className="redteam-badge allowed">ALLOWED</span>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {summary && (
        <p className={`redteam-summary ${summary.ok ? 'ok' : 'bad'}`} data-testid="redteam-summary">
          {summary.denied}/{summary.attempts} denied by MongoDB. Payouts caused: {summary.landed.ledger}.
          {!summary.ok && ` ${summary.problems.join('; ')}`}
        </p>
      )}
      {phase === 'error' && <p className="redteam-summary bad">Red-team run failed: {error}</p>}
    </section>
  );
}
