/**
 * Chaos hooks (PRD E8, TEST_PLAN section 4).
 *
 *   1  event received, before the ledger `pending` insert
 *   2  after the `pending` insert (and checks), before the provider call
 *   3  after the provider call returns, before the ledger update
 *   4  after the ledger update, before the resume token is saved
 *
 * CRASH_AT=<point> kills the process with SIGKILL the first time that point
 * is reached. CRASH_ON_HIT=<n> waits for the n-th time instead (default 1).
 */
export type CrashPoint = 1 | 2 | 3 | 4;

export class Crasher {
  private hits = 0;

  constructor(
    private readonly point: CrashPoint | undefined,
    private readonly onHit = 1,
    private readonly log: (msg: string) => void = (m) => console.error(m),
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Crasher {
    const raw = env.CRASH_AT?.trim();
    if (!raw) return new Crasher(undefined);
    const point = Number(raw);
    if (![1, 2, 3, 4].includes(point)) {
      throw new Error(`CRASH_AT must be 1, 2, 3 or 4 (got "${raw}")`);
    }
    const onHit = env.CRASH_ON_HIT ? Number(env.CRASH_ON_HIT) : 1;
    if (!Number.isInteger(onHit) || onHit < 1) {
      throw new Error(`CRASH_ON_HIT must be a positive integer (got "${env.CRASH_ON_HIT}")`);
    }
    return new Crasher(point as CrashPoint, onHit);
  }

  get armed(): boolean {
    return this.point !== undefined;
  }

  at(point: CrashPoint): void {
    if (point !== this.point) return;
    this.hits += 1;
    if (this.hits < this.onHit) return;
    this.log(`[executor] CRASH_AT=${point} reached, sending SIGKILL to self`);
    process.kill(process.pid, "SIGKILL");
  }
}
