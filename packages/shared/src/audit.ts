/**
 * S9: verify the hash chains behind one trace, or behind everything. Needs only `find`
 * (the dashboard user is enough).
 */
import type { Db } from 'mongodb';
import { verifyChain, type ChainCheck } from './chain.js';
import { COLLECTIONS } from './collections.js';
import type { AgentTraceDoc, ApprovalDoc, ReviewQueueDoc } from './types.js';

/** The agent's trace chain and the approval chain of every review on this trace. */
export async function verifyTrace(db: Db, traceId: string): Promise<ChainCheck> {
  const traces = await db.collection<AgentTraceDoc>(COLLECTIONS.agent_traces).find({ trace_id: traceId }).toArray();
  const result = traces.length
    ? verifyChain(traces, (r) => `agent_traces seq ${r['seq']}`)
    : { ok: true, checked: 0, problems: [] };
  const reviews = await db
    .collection<ReviewQueueDoc>(COLLECTIONS.review_queue)
    .find({ trace_id: traceId }, { projection: { _id: 1 } })
    .toArray();
  for (const review of reviews) {
    const approvals = await db.collection<ApprovalDoc>(COLLECTIONS.approvals).find({ review_id: review._id }).toArray();
    if (!approvals.length) continue;
    const check = verifyChain(approvals, (r) => `approval by ${r['approver_id']}`);
    result.checked += check.checked;
    result.problems.push(...check.problems);
  }
  result.ok = result.problems.length === 0;
  return result;
}

export interface AuditReport {
  traces: number;
  reviews: number;
  records: number;
  problems: Array<{ chain: string; problem: string }>;
}

/** Every trace chain and every review's approval chain in the database. */
export async function verifyAll(db: Db): Promise<AuditReport> {
  const report: AuditReport = { traces: 0, reviews: 0, records: 0, problems: [] };
  const traceIds = await db.collection<AgentTraceDoc>(COLLECTIONS.agent_traces).distinct('trace_id');
  for (const traceId of traceIds) {
    const traces = await db.collection<AgentTraceDoc>(COLLECTIONS.agent_traces).find({ trace_id: traceId }).toArray();
    const check = verifyChain(traces, (r) => `seq ${r['seq']}`);
    report.traces += 1;
    report.records += check.checked;
    for (const p of check.problems) report.problems.push({ chain: `trace ${traceId}`, problem: p });
  }
  const reviewIds = await db.collection<ApprovalDoc>(COLLECTIONS.approvals).distinct('review_id');
  for (const reviewId of reviewIds) {
    const approvals = await db.collection<ApprovalDoc>(COLLECTIONS.approvals).find({ review_id: reviewId }).toArray();
    const check = verifyChain(approvals, (r) => `approval by ${r['approver_id']}`);
    report.reviews += 1;
    report.records += check.checked;
    for (const p of check.problems) report.problems.push({ chain: `review ${reviewId.toHexString()}`, problem: p });
  }
  return report;
}
