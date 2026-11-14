import type { ObjectId } from 'mongodb';
import type { ApprovedDoc, IntentDoc, LedgerDoc } from '@escrowops/shared';

/** The two collections the executor pays from. */
export type SourceCollection = 'intents' | 'approved';

export type RefundSourceDoc = IntentDoc | ApprovedDoc;

export const SOURCE_TYPE: Record<SourceCollection, LedgerDoc['source_type']> = {
  intents: 'intent',
  approved: 'approved',
};

/**
 * A `ledger` document as the executor writes it: the shared LedgerDoc plus the
 * bookkeeping that makes recovery deterministic. `ledger` has no validator, so
 * the extra fields are allowed; readers that only know LedgerDoc can ignore them.
 */
export interface ExecutorLedgerDoc extends Omit<LedgerDoc, '_id'> {
  _id?: ObjectId;
  ticket_id: string;
  /** Set once the E5 checks pass. A pending entry with this set may already have been paid. */
  checks_passed: boolean;
  /** The executor instance that last claimed this entry. */
  owner: string;
  /** Provider calls made so far. */
  attempts: number;
}

/** Readable label for logs, e.g. `intent:6650…`. */
export const sourceLabel = (coll: SourceCollection, id: ObjectId): string =>
  `${SOURCE_TYPE[coll]}:${id.toHexString()}`;
