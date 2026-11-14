/** A5: works a queue of tickets and prints a status line (or block) per ticket as each finishes. */
import { resolveTicket, type AgentOptions, type TicketResult } from './agent.js';

const dollars = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const paint = (on: boolean) => {
  const wrap = (code: number) => (s: string) => (on ? `\u001b[${code}m${s}\u001b[0m` : s);
  return { green: wrap(32), amber: wrap(33), red: wrap(31), dim: wrap(2), bold: wrap(1) };
};

/**
 * One ticket's outcome, as the demo shows it. A held proposal prints the server's own
 * rejection: "MongoServerError: Document failed validation (code 121)" and the failed rule.
 */
export function statusLine(r: TicketResult, opts: { color?: boolean } = {}): string {
  const c = paint(opts.color ?? false);
  const id = c.bold(r.ticket_id.padEnd(8));
  const pad = ' '.repeat(9);
  const d = r.decision;
  switch (r.status) {
    case 'proposed':
      return `${id} ${c.green('✔')} ${dollars(d && 'amount_cents' in d ? d.amount_cents : 0)} auto-approved -> intents ${c.dim('(the executor pays it)')}`;
    case 'held': {
      if (d?.status !== 'held') return `${id} ${c.amber('■')} held for review`;
      return [
        `${id} ${c.amber('■')} ${dollars(d.amount_cents)} refused as an auto refund by MongoDB`,
        `${pad}${c.red('MongoServerError: Document failed validation (code 121)')}`,
        ...(d.violations.length ? d.violations : d.rules).map((v) => `${pad}  ${v}`),
        `${pad}${c.amber(`→ routed to review_queue (${d.tier}, needs ${d.required_approvals} approval${d.required_approvals === 1 ? '' : 's'})`)}`,
      ].join('\n');
    }
    case 'already_proposed':
      return `${id} ${c.dim('·')} already proposed earlier; nothing new`;
    case 'declined':
      return `${id} ${c.red('✖')} declined: ${d?.status === 'declined' ? d.reason : ''}`;
    case 'frozen':
      return `${id} ${c.red('⏸')} ${c.red('MongoServerError: not authorized (code 13)')} agent is frozen; proposal not written`;
    default:
      return `${id} ${c.red('!')} ${r.status}${r.detail ? `: ${r.detail}` : ''}`;
  }
}

export async function runBatch(
  ticketIds: string[],
  opts: AgentOptions & {
    concurrency?: number;
    onResult?: (r: TicketResult) => void;
    /** Called once when a frozen result stops the batch, with the tickets never started. */
    onFrozen?: (skipped: string[]) => void;
  },
): Promise<TicketResult[]> {
  const queue = [...ticketIds];
  const results: TicketResult[] = [];
  let frozen = false;
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      let r: TicketResult;
      try {
        r = await resolveTicket(id, opts);
      } catch (err) {
        r = { ticket_id: id, trace_id: '', status: 'error', detail: (err as Error).message, turns: 0 };
      }
      results.push(r);
      opts.onResult?.(r);
      // Kill switch: the database revoked the agent's write privilege. Stop taking tickets;
      // the ones still in flight hit the same refusal on their next write.
      if (r.status === 'frozen' && !frozen) {
        frozen = true;
        opts.onFrozen?.(queue.splice(0));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return results;
}
