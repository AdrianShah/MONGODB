import type { ObjectId } from 'mongodb';
import type { ApprovedDoc, IntentDoc, LedgerDoc } from '@escrowops/shared';

/** The two collections the executor pays from. */
export type SourceCollection = LedgerDoc['source_collection'];

export type RefundSourceDoc = IntentDoc | ApprovedDoc;

/** A `ledger` document before the server assigns its `_id`. */
export type ExecutorLedgerDoc = Omit<LedgerDoc, '_id'> & { _id?: ObjectId };
