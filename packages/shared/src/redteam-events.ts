/**
 * Shapes of a red-team run, type-only and dependency-free so the dashboard UI can import them.
 * The implementation is in ./redteam.ts. Streamed by POST /api/redteam/run as Server-Sent Events,
 * one event per RedTeamStreamEvent (`event: <type>`, `data: <json>`).
 */

export type AttackId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8' | 'R9' | 'R10';

export interface AttackResult {
  id: AttackId;
  name: string;
  /** The server refused the attack. */
  denied: boolean;
  /** Server error code, undefined when the attack succeeded. */
  code: number | undefined;
  codeName: string | undefined;
  /** Short, human-readable reason (the 13 errmsg echoes the whole command). */
  message: string;
  /** The server's errmsg, first line, at most 240 characters. Undefined when the attack succeeded. */
  errmsg: string | undefined;
  expectedCode: number;
  /** Refused with exactly the expected code. */
  asExpected: boolean;
}

export interface RedTeamAttackInfo {
  id: AttackId;
  label: string;
  tried: string;
  expectedCode: number;
}

export interface RedTeamSummary {
  run_id: string;
  attempts: number;
  denied: number;
  allowed: number;
  /** Refused, but with a different code than expected (blocked by another layer). */
  unexpected: number;
  /** Sum of `amount_cents` of ledger entries tied to this run (should be 0). */
  paid_cents: number;
  /** Documents tied to this run found afterwards, per collection (all should be 0). */
  landed: { approved: number; ledger: number; intents: number };
  target_edited: boolean;
  problems: string[];
  /** Everything refused as expected and nothing landed. */
  ok: boolean;
  /** Something got through (an allowed attack, a landed document or an edited intent). */
  breached: boolean;
}

export type RedTeamEvent =
  | { type: 'start'; run_id: string; username: string; db: string; attacks: RedTeamAttackInfo[] }
  | { type: 'attempt'; index: number; id: AttackId }
  | { type: 'result'; index: number; id: AttackId; label: string; tried: string; result: AttackResult }
  | { type: 'summary'; summary: RedTeamSummary };

/** What the approval service streams: the run's events, plus who started it and a terminal error. */
export type RedTeamStreamEvent =
  | (Extract<RedTeamEvent, { type: 'start' }> & { approver: string })
  | Exclude<RedTeamEvent, { type: 'start' }>
  | { type: 'error'; message: string };
