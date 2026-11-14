/**
 * S2: review queue changes, live. One Change Stream on `review_queue` (every decision also
 * touches the review document, so approvals show up here too), turned into review cards
 * and handed to subscribers. Resumes from its last event after an error.
 */
import type { ChangeStream, ChangeStreamDocument, Collection, Db, ResumeToken } from 'mongodb';
import { COLLECTIONS } from '@escrowops/shared';
import type { ReviewCard, ReviewDoc, ReviewService } from './reviews.js';

export class ReviewFeed {
  private stream?: ChangeStream<ReviewDoc, ChangeStreamDocument<ReviewDoc>>;
  private stopped = false;
  private loop?: Promise<void>;
  private readonly listeners = new Set<(card: ReviewCard) => void>();
  private readonly reviews: Collection<ReviewDoc>;

  constructor(
    db: Db,
    private readonly service: ReviewService,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.reviews = db.collection<ReviewDoc>(COLLECTIONS.review_queue);
  }

  subscribe(fn: (card: ReviewCard) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Opens the stream. Resolves once it is established, so no later change is missed. */
  async start(): Promise<void> {
    await this.open(undefined);
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.stream?.close().catch(() => {});
    await this.loop?.catch(() => {});
  }

  private async open(resumeAfter: ResumeToken | undefined) {
    this.stream = this.reviews.watch([{ $match: { operationType: { $in: ['insert', 'update', 'replace'] } } }], {
      fullDocument: 'updateLookup',
      ...(resumeAfter ? { resumeAfter } : {}),
    });
    // watch() is lazy; tryNext() runs the aggregate now and surfaces auth errors early.
    const first = await this.stream.tryNext();
    if (first) await this.emit(first);
  }

  private async run() {
    let token: ResumeToken | undefined;
    while (!this.stopped) {
      try {
        for await (const change of this.stream!) {
          token = change._id;
          await this.emit(change);
        }
        if (this.stopped) break;
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        if (this.stopped) break;
        this.log(`[api] review feed error, reopening in 1s: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (this.stopped) break;
      await this.stream?.close().catch(() => {});
      try {
        await this.open(token);
      } catch (err) {
        this.log(`[api] could not reopen review feed: ${(err as Error).message}`);
      }
    }
  }

  private async emit(change: ChangeStreamDocument<ReviewDoc>) {
    if (!('fullDocument' in change) || !change.fullDocument) return;
    const [card] = await this.service.toCards([change.fullDocument]);
    if (!card) return;
    for (const fn of this.listeners) {
      try {
        fn(card);
      } catch {
        // A broken subscriber must not stop the feed.
      }
    }
  }
}
