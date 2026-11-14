/**
 * S1: the two seeded approvers and their sessions. The approver ID used for every
 * decision comes from the session created here, never from a request body.
 *
 * Accounts come from APPROVERS ("id:password,id:password"); the dev defaults below are
 * for local and test databases only. Sessions live in memory: restarting logs everyone out.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Env } from '@escrowops/shared';

export interface ApproverAccount {
  id: string;
  password: string;
}

export const DEFAULT_APPROVERS: readonly ApproverAccount[] = Object.freeze([
  { id: 'approver-a', password: 'approver-a-dev-password' },
  { id: 'approver-b', password: 'approver-b-dev-password' },
]);

export class InvalidApproversError extends Error {}

export function loadApprovers(env: Env = process.env): ApproverAccount[] {
  const raw = env['APPROVERS']?.trim();
  if (!raw) return DEFAULT_APPROVERS.map((a) => ({ ...a }));
  const accounts = raw.split(',').map((entry) => {
    const i = entry.indexOf(':');
    const id = entry.slice(0, i).trim();
    const password = entry.slice(i + 1);
    if (i < 1 || !password) throw new InvalidApproversError('APPROVERS must look like "id:password,id:password"');
    return { id, password };
  });
  if (new Set(accounts.map((a) => a.id)).size !== accounts.length) {
    throw new InvalidApproversError('APPROVERS lists the same approver ID twice');
  }
  return accounts;
}

const hash = (password: string, salt: Buffer) => scryptSync(password, salt, 32);

/** Checks passwords against salted scrypt hashes; plain passwords are not kept. */
export class ApproverDirectory {
  private readonly accounts = new Map<string, { salt: Buffer; hash: Buffer }>();

  constructor(accounts: readonly ApproverAccount[]) {
    for (const a of accounts) {
      const salt = randomBytes(16);
      this.accounts.set(a.id, { salt, hash: hash(a.password, salt) });
    }
  }

  get ids(): string[] {
    return [...this.accounts.keys()];
  }

  /** The approver ID if the credentials are right. */
  verify(id: string, password: string): string | undefined {
    const account = this.accounts.get(id);
    // Hash even for an unknown ID so timing does not reveal which IDs exist.
    const salt = account?.salt ?? randomBytes(16);
    const candidate = hash(password, salt);
    return account && timingSafeEqual(candidate, account.hash) ? id : undefined;
  }
}

export class SessionStore {
  private readonly sessions = new Map<string, { approverId: string; expires: number }>();

  constructor(private readonly ttlMs = 12 * 60 * 60 * 1000) {}

  create(approverId: string): string {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { approverId, expires: Date.now() + this.ttlMs });
    return token;
  }

  approverFor(token: string | undefined): string | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expires < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return s.approverId;
  }

  delete(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}
