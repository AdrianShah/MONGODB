/** A5: works a queue of tickets and prints one status line per ticket as each finishes. */
import { resolveTicket, type AgentOptions, type TicketResult } from './agent.js';

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export function statusLine(r: TicketResult): string {
  const d = r.decision;
  let what: string;
  switch (r.status) {
    case 'proposed':
      what = `proposed ${dollars(d && 'amount_cents' in d ? d.amount_cents : 0)} -> intents (auto, pays out)`;
      break;
    case 'held':
      what =
        d?.status === 'held'
          ? `proposed ${dollars(d.amount_cents)} -> review_queue (${d.tier}; validator: ${d.rules.join(', ') || 'rejected'})`
          : 'held for review';
      break;
    case 'already_proposed':
      what = 'already proposed earlier, nothing new';
      break;
    case 'declined':
      what = `declined: ${d?.status === 'declined' ? d.reason : ''}`;
      break;
    default:
      what = `${r.status}${r.detail ? `: ${r.detail}` : ''}`;
  }
  return `${r.ticket_id.padEnd(8)} ${what}`;
}

export async function runBatch(
  ticketIds: string[],
  opts: AgentOptions & { concurrency?: number; onResult?: (r: TicketResult) => void },
): Promise<TicketResult[]> {
  const queue = [...ticketIds];
  const results: TicketResult[] = [];
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
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return results;
}
