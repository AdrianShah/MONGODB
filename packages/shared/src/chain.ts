/**
 * S9: hash chains on audit records, so an edit by a privileged user is detectable.
 *
 * Each record in a chain stores `prev_hash` (the previous record's `hash`, or GENESIS for the
 * first) and `hash` = sha256(prev_hash + canonical EJSON of every other field). Changing any
 * field of any record, inserting a record, or deleting one from the middle breaks the chain.
 * Deleting the newest record cannot be detected without an external anchor; that is the known
 * limit of a plain hash chain.
 *
 * Chains: agent_traces per trace_id (written by the agent), approvals per review_id (written by
 * the approval service inside its transaction).
 */
import { createHash } from 'node:crypto';
import { BSON, type Document } from 'mongodb';

const { EJSON } = BSON;

export const GENESIS = '0'.repeat(64);

export interface Chained {
  prev_hash?: string;
  hash?: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && value.constructor === Object) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** The hash a record should carry, given the previous hash. Ignores its own prev_hash/hash. */
export function chainHash(prevHash: string, record: Document): string {
  const { prev_hash: _p, hash: _h, ...fields } = record;
  // Canonical extended JSON keeps types (dates, ObjectIds, int vs double) and key order stable.
  const body = JSON.stringify(canonical(EJSON.serialize(fields, { relaxed: false })));
  return createHash('sha256').update(`${prevHash}\n${body}`).digest('hex');
}

/** Adds prev_hash and hash to a record about to be inserted. */
export function sealRecord<T extends Document>(prevHash: string, record: T): T & Required<Chained> {
  return { ...record, prev_hash: prevHash, hash: chainHash(prevHash, record) };
}

export interface ChainCheck {
  ok: boolean;
  /** Records whose hash verified. */
  checked: number;
  problems: string[];
}

/**
 * Verifies one chain by following the links from GENESIS, so it does not depend on the order
 * the records are given in. `label` names a record in problem messages.
 */
export function verifyChain(records: Array<Document & Chained>, label: (r: Document) => string = (r) => String(r['_id'])): ChainCheck {
  const problems: string[] = [];
  const unsealed = records.filter((r) => !r.hash);
  if (unsealed.length) problems.push(`${unsealed.length} record(s) have no hash (${unsealed.map(label).join(', ')})`);

  const byPrev = new Map<string, Array<Document & Chained>>();
  for (const r of records.filter((x) => x.hash)) byPrev.set(r.prev_hash ?? '', [...(byPrev.get(r.prev_hash ?? '') ?? []), r]);

  let prev = GENESIS;
  let checked = 0;
  const seen = new Set<Document>();
  for (;;) {
    const next = byPrev.get(prev) ?? [];
    if (next.length === 0) break;
    if (next.length > 1) problems.push(`chain forks after ${prev.slice(0, 12)}: ${next.map(label).join(', ')}`);
    const r = next[0]!;
    seen.add(r);
    if (chainHash(prev, r) !== r.hash) {
      problems.push(`${label(r)} was changed after it was written`);
      break;
    }
    checked += 1;
    prev = r.hash!;
  }
  const orphans = records.filter((r) => r.hash && !seen.has(r));
  if (orphans.length) problems.push(`${orphans.map(label).join(', ')} not linked to the chain (a record before it was deleted or altered)`);
  return { ok: problems.length === 0, checked, problems };
}
