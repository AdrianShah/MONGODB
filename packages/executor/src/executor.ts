import { randomBytes } from 'node:crypto';
import {
  MongoServerError,
  type ChangeStream,
  type ChangeStreamInsertDocument,
  type Collection,
  type Db,
  type ResumeToken,
  type Timestamp,
} from 'mongodb';
import { COLLECTIONS, ledgerSourceId, type ExecutorStateDoc, type OrderDoc } from '@escrowops/shared';
import { Crasher } from './crash.js';
import { PermanentProviderError, TransientProviderError, type PaymentProvider } from './providers/types.js';
import type { ExecutorLedgerDoc, RefundSourceDoc, SourceCollection } from './types.js';

export interface ExecutorOptions {
  db: Db;
  provider: PaymentProvider;
  crasher?: Crasher;
  log?: (line: string) => void;
  /** Identifies this process in `ledger.owner`. */
  instanceId?: string;
  /** Provider attempts per payout before leaving it pending for a later reconcile. */
  maxTransientAttempts?: number;
  retryBaseMs?: number;
  /** How often to look for pending entries abandoned by a dead executor (0 disables). */
  staleReconcileEveryMs?: number;
  /** A pending entry untouched for this long is considered abandoned. */
  staleAfterMs?: number;
}

const SOURCES: SourceCollection[] = [COLLECTIONS.intents, COLLECTIONS.approved];
// InvalidResumeToken, ChangeStreamFatalError, ChangeStreamHistoryLost
const HISTORY_LOST_CODES = new Set([260, 280, 286]);

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isDuplicateKey = (err: unknown) => err instanceof MongoServerError && err.code === 11000;
const streamKey = (coll: SourceCollection) => `stream:${coll}`;

/**
 * Pays every document inserted into `intents` or `approved` exactly once.
 *
 * Exactly-once rests on three things:
 *  - `ledger.source_id` is unique, so only one ledger entry (and one owner) exists per source.
 *  - The provider is called with the ledger `source_id` as its idempotency key, so repeating a
 *    call after a crash returns the original refund instead of creating a second one. (Not the
 *    proposal's `idempotency_key`: that is the same on every run of a ticket, so after
 *    `npm run reset` the provider would replay the previous run's refund.)
 *  - Recovery never has to guess: a `pending` entry is retried with the same key, a source
 *    with no entry is processed from scratch, and a replayed stream event hits the unique index.
 */
export class Executor {
  readonly instanceId: string;
  private readonly db: Db;
  private readonly provider: PaymentProvider;
  private readonly crash: Crasher;
  private readonly log: (line: string) => void;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly staleEveryMs: number;
  private readonly staleAfterMs: number;

  private readonly ledger: Collection<ExecutorLedgerDoc>;
  private readonly orders: Collection<OrderDoc>;
  private readonly state: Collection<ExecutorStateDoc>;

  private stopped = false;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private readonly streams = new Set<ChangeStream>();
  private readonly loops: Promise<void>[] = [];
  private staleTimer?: NodeJS.Timeout;

  constructor(opts: ExecutorOptions) {
    this.db = opts.db;
    this.provider = opts.provider;
    this.crash = opts.crasher ?? new Crasher(undefined);
    this.log = opts.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`));
    this.instanceId = opts.instanceId ?? `executor-${process.pid}-${randomBytes(3).toString('hex')}`;
    this.maxAttempts = opts.maxTransientAttempts ?? 5;
    this.retryBaseMs = opts.retryBaseMs ?? 200;
    this.staleEveryMs = opts.staleReconcileEveryMs ?? 15_000;
    this.staleAfterMs = opts.staleAfterMs ?? 30_000;
    this.ledger = this.db.collection<ExecutorLedgerDoc>(COLLECTIONS.ledger);
    this.orders = this.db.collection<OrderDoc>(COLLECTIONS.orders);
    this.state = this.db.collection<ExecutorStateDoc>(COLLECTIONS.executor_state);
  }

  /**
   * Opens the streams, reconciles pending payouts left by a previous run (E3), and sweeps
   * sources with no ledger entry (E4). Resolves once that startup work has finished.
   */
  async start(): Promise<void> {
    const startedAt = new Date();
    // Fix the stream's starting point before the sweep: everything earlier is found by the
    // sweep, everything later by the stream, and the overlap is absorbed by the unique index.
    const startAt = await this.operationTime();
    const tokens = new Map<string, ResumeToken>();
    for (const doc of await this.state.find({ _id: { $in: SOURCES.map(streamKey) } }).toArray()) {
      tokens.set(doc._id, doc.resume_token as ResumeToken);
    }
    if (tokens.size > 0) this.log(`[executor] resuming from saved token (${[...tokens.keys()].join(', ')})`);

    const startup = Promise.all([
      this.enqueue(() => this.reconcilePending({ updatedBefore: startedAt })),
      this.enqueue(() => this.sweep()),
    ]);
    for (const coll of SOURCES) {
      this.loops.push(this.runStream(coll, tokens.get(streamKey(coll)), startAt));
    }
    await startup;

    if (this.staleEveryMs > 0) {
      this.staleTimer = setInterval(() => {
        const before = new Date(Date.now() - this.staleAfterMs);
        void this.enqueue(() => this.reconcilePending({ updatedBefore: before })).catch(() => {});
      }, this.staleEveryMs);
      this.staleTimer.unref();
    }
    this.log(`[executor] ready (${this.instanceId}, provider=${this.provider.name}, resumed=${tokens.size > 0})`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.staleTimer) clearInterval(this.staleTimer);
    await Promise.all([...this.streams].map((s) => s.close().catch(() => {})));
    await Promise.allSettled(this.loops);
    await this.idle();
  }

  /** Resolves once nothing is queued (tests use this). */
  async idle(): Promise<void> {
    while (this.queued > 0) await this.tail;
  }

  // ---- queue -------------------------------------------------------------------------------

  /** All work runs one task at a time, in arrival order. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queued += 1;
    const run = this.tail.then(task).finally(() => {
      this.queued -= 1;
    });
    this.tail = run.catch((err) => this.log(`[executor] task failed: ${(err as Error).stack ?? err}`));
    return run;
  }

  // ---- change streams (E1, E3) -------------------------------------------------------------

  private async runStream(coll: SourceCollection, token: ResumeToken | undefined, startAt: Timestamp) {
    let resumeAfter = token;
    let startAtOperationTime: Timestamp | undefined = startAt;
    while (!this.stopped) {
      const stream = this.db
        .collection<RefundSourceDoc>(coll)
        .watch<RefundSourceDoc, ChangeStreamInsertDocument<RefundSourceDoc>>(
          [{ $match: { operationType: 'insert' } }],
          resumeAfter ? { resumeAfter } : { startAtOperationTime },
        );
      this.streams.add(stream);
      try {
        for await (const change of stream) {
          await this.enqueue(() => this.handleEvent(coll, change));
          resumeAfter = change._id;
        }
        // Ended without an error (e.g. the collection was dropped): pause so it cannot spin.
        if (!this.stopped) {
          this.log(`[executor] ${coll} stream ended, reopening in 1s`);
          await sleep(1000);
        }
      } catch (err) {
        if (this.stopped) break;
        if (err instanceof MongoServerError && HISTORY_LOST_CODES.has(Number(err.code))) {
          // The saved token is no longer usable. Restart from now and sweep for what we missed.
          this.log(`[executor] ${coll} resume token unusable (${err.code}); restarting stream and sweeping`);
          resumeAfter = undefined;
          startAtOperationTime = await this.operationTime();
          void this.enqueue(() => this.sweep()).catch(() => {});
        } else {
          this.log(`[executor] ${coll} stream error, reopening in 1s: ${(err as Error).message}`);
          await sleep(1000);
        }
      } finally {
        this.streams.delete(stream);
        await stream.close().catch(() => {});
      }
    }
  }

  private async handleEvent(coll: SourceCollection, change: ChangeStreamInsertDocument<RefundSourceDoc>) {
    await this.processSource(coll, change.fullDocument);
    this.crash.at(4);
    await this.state.updateOne(
      { _id: streamKey(coll) },
      { $set: { resume_token: change._id, updated_at: new Date() } },
      { upsert: true },
    );
  }

  // ---- recovery (E3, E4) -------------------------------------------------------------------

  /** Retries every pending entry last touched before `updatedBefore`, with its original key. */
  private async reconcilePending({ updatedBefore }: { updatedBefore: Date }) {
    const stale = await this.ledger.find({ status: 'pending', updated_at: { $lt: updatedBefore } }).toArray();
    for (const entry of stale) {
      // Each entry on its own: one that throws is logged and skipped, never blocking the rest
      // or stopping the executor from starting. It stays pending for the next reconcile.
      try {
        // Claim it atomically so two executors never both reconcile the same entry.
        const claimed = await this.ledger.findOneAndUpdate(
          { _id: entry._id, status: 'pending', updated_at: entry.updated_at },
          { $set: { owner: this.instanceId, updated_at: new Date() } },
          { returnDocument: 'after' },
        );
        if (!claimed) continue;
        this.log(`[executor] reconciling pending payout ${claimed.source_id} (${dollars(claimed.amount_cents)}, ticket ${claimed.ticket_id})`);
        await this.checkAndPay(claimed, true);
      } catch (err) {
        this.log(`[executor] reconcile of ${entry.source_id} failed, will retry later: ${(err as Error).message}`);
      }
    }
  }

  /** Processes any source document that has no ledger entry at all. */
  private async sweep() {
    for (const coll of SOURCES) {
      const missing = this.db.collection<RefundSourceDoc>(coll).aggregate<RefundSourceDoc>([
        {
          $lookup: {
            from: COLLECTIONS.ledger,
            let: { sid: { $concat: [`${coll}:`, { $toString: '$_id' }] } },
            pipeline: [{ $match: { $expr: { $eq: ['$source_id', '$$sid'] } } }, { $project: { _id: 1 } }],
            as: 'ledger',
          },
        },
        { $match: { ledger: { $size: 0 } } },
        { $project: { ledger: 0 } },
        { $sort: { created_at: 1 } },
      ]);
      for await (const doc of missing) {
        this.log(`[executor] sweep found unpaid ${ledgerSourceId(coll, doc._id)}`);
        await this.processSource(coll, doc);
      }
    }
  }

  // ---- payout (E2, E5) ---------------------------------------------------------------------

  private async processSource(coll: SourceCollection, doc: RefundSourceDoc) {
    this.crash.at(1);
    const now = new Date();
    const entry: ExecutorLedgerDoc = {
      source_id: ledgerSourceId(coll, doc._id),
      source_collection: coll,
      source_doc_id: doc._id,
      trace_id: doc.trace_id,
      ticket_id: doc.ticket_id,
      order_id: doc.order_id,
      customer_id: doc.customer_id,
      amount_cents: doc.amount_cents,
      currency: doc.currency,
      status: 'pending',
      provider: this.provider.name,
      checks_passed: false,
      owner: this.instanceId,
      attempts: 0,
      created_at: now,
      updated_at: now,
    };
    try {
      const { insertedId } = await this.ledger.insertOne(entry);
      entry._id = insertedId;
    } catch (err) {
      if (isDuplicateKey(err)) return; // Already claimed: a replayed event, the sweep overlap, or another executor.
      throw err;
    }
    await this.checkAndPay(entry);
  }

  private async checkAndPay(entry: ExecutorLedgerDoc, reconciling = false) {
    if (!entry.checks_passed) {
      const failure = await this.check(entry);
      if (failure) {
        await this.finish(entry, { status: 'failed', failure_reason: failure });
        this.log(`[executor] refused ${label(entry)} ${dollars(entry.amount_cents)}: ${failure}`);
        return;
      }
      // Recorded before the provider call: from here on, recovery must retry, never re-check.
      await this.ledger.updateOne(
        { _id: entry._id, status: 'pending' },
        { $set: { checks_passed: true, updated_at: new Date() } },
      );
      entry.checks_passed = true;
    }
    this.crash.at(2);
    await this.pay(entry, reconciling);
  }

  /** E5: the checks a validator cannot express because they need another document. */
  private async check(entry: ExecutorLedgerDoc): Promise<string | undefined> {
    const order = await this.orders.findOne({ _id: entry.order_id });
    if (!order) return `order_not_found: ${entry.order_id}`;
    if (order.customer_id !== entry.customer_id) {
      return `order_customer_mismatch: order ${entry.order_id} belongs to ${order.customer_id}, not ${entry.customer_id}`;
    }
    if (!order.payment_id) return `order_missing_payment_id: order ${entry.order_id} has no payment to refund against`;
    // One payout per ticket: the provider keys are per source document, so it would not catch
    // an auto-paid intent followed by an approved refund for the same ticket.
    const sameTicket = await this.ledger.findOne(
      { ticket_id: entry.ticket_id, status: { $in: ['pending', 'succeeded'] }, _id: { $ne: entry._id } },
      { projection: { source_id: 1 } },
    );
    if (sameTicket) return `duplicate_ticket_payout: ticket ${entry.ticket_id} already has ${sameTicket.source_id}`;
    // Other pending entries count too, which errs toward refusing rather than overpaying.
    const [committed] = await this.ledger
      .aggregate<{ total: number }>([
        { $match: { order_id: entry.order_id, status: { $in: ['pending', 'succeeded'] }, _id: { $ne: entry._id } } },
        { $group: { _id: null, total: { $sum: '$amount_cents' } } },
      ])
      .toArray();
    const remaining = order.amount_cents - (order.refunded_cents ?? 0) - (committed?.total ?? 0);
    if (entry.amount_cents > remaining) {
      return `exceeds_refundable: ${dollars(entry.amount_cents)} requested, ${dollars(Math.max(remaining, 0))} remaining on order ${entry.order_id}`;
    }
    return undefined;
  }

  private async pay(entry: ExecutorLedgerDoc, reconciling = false) {
    const order = await this.orders.findOne({ _id: entry.order_id });
    if (!order) {
      await this.finish(entry, { status: 'failed', failure_reason: `order_not_found: ${entry.order_id}` });
      return;
    }
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.ledger.updateOne(
        { _id: entry._id, status: 'pending' },
        { $inc: { attempts: 1 }, $set: { updated_at: new Date() } },
      );
      try {
        const result = await this.provider.refund({
          paymentRef: order.payment_id,
          amountCents: entry.amount_cents,
          currency: entry.currency,
          idempotencyKey: entry.source_id,
          metadata: { source_id: entry.source_id, trace_id: entry.trace_id, ticket_id: entry.ticket_id },
        });
        this.crash.at(3);
        await this.finish(entry, { status: 'succeeded', provider: this.provider.name, provider_refund_id: result.refundId });
        this.log(
          reconciling
            ? `[executor] reconciled ${label(entry)}: provider returned ${result.refundId} for the same key (no second refund); marked succeeded`
            : `[executor] paid ${label(entry)} ${dollars(entry.amount_cents)} -> ${result.refundId} (ticket ${entry.ticket_id})`,
        );
        return;
      } catch (err) {
        if (err instanceof PermanentProviderError) {
          await this.finish(entry, { status: 'failed', provider: this.provider.name, failure_reason: err.message });
          this.log(`[executor] payout failed for ${label(entry)}: ${err.message}`);
          return;
        }
        if (!(err instanceof TransientProviderError)) throw err;
        this.log(`[executor] transient error on ${label(entry)} (attempt ${attempt}/${this.maxAttempts}): ${err.message}`);
        if (attempt < this.maxAttempts) await sleep(this.retryBaseMs * 2 ** (attempt - 1));
      }
    }
    // Still pending; the periodic reconcile retries it later with the same key.
    this.log(`[executor] giving up for now on ${label(entry)}; left pending for reconcile`);
  }

  private async finish(entry: ExecutorLedgerDoc, fields: Partial<ExecutorLedgerDoc>) {
    await this.ledger.updateOne({ _id: entry._id, status: 'pending' }, { $set: { ...fields, updated_at: new Date() } });
  }

  private async operationTime(): Promise<Timestamp> {
    const res = await this.db.command({ ping: 1 });
    const t = res['operationTime'] as Timestamp | undefined;
    if (!t) throw new Error('No operationTime from the server; Change Streams need a replica set or Atlas cluster.');
    return t;
  }
}

const label = (entry: ExecutorLedgerDoc) => entry.source_id;
