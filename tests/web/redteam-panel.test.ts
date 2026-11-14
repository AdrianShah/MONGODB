/**
 * The dashboard's "Run red team" panel: POST /api/redteam/run through the dashboard proxy
 * runs the five demo attacks as the agent and streams one SSE `result` per attack, each
 * refused by the server with a real MongoDB error code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedTeamStreamEvent } from '@escrowops/shared/redteam-events';
import { testServerUri } from '../helpers/index.js';
import { startStack, type Stack } from '../helpers/stack.js';

let s: Stack;
let cookie: string;

beforeAll(async () => {
  s = await startStack(testServerUri(), { prefix: 'redteam', redteam: true });
  const res = await fetch(`${s.dashboardUrl}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ approver_id: 'approver-a', password: 'approver-a-dev-password' }),
  });
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
});
afterAll(async () => {
  await s?.stop();
});

function parseSse(body: string): RedTeamStreamEvent[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => !!l)
    .map((l) => JSON.parse(l.slice(6)) as RedTeamStreamEvent);
}

describe('red-team panel endpoint', () => {
  it('needs an approver session', async () => {
    expect((await fetch(`${s.dashboardUrl}/api/redteam/run`, { method: 'POST' })).status).toBe(401);
  });

  it('streams five denied attacks with MongoDB error codes, and nothing lands', async () => {
    const res = await fetch(`${s.dashboardUrl}/api/redteam/run`, { method: 'POST', headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const events = parseSse(await res.text());

    const start = events.find((e) => e.type === 'start');
    expect(start).toMatchObject({ approver: 'approver-a', username: expect.stringMatching(/agent/) });

    const results = events.flatMap((e) => (e.type === 'result' ? [e] : []));
    expect(results.map((r) => r.id)).toEqual(['R1', 'R2', 'R4', 'R5', 'R6']);
    for (const r of results) {
      expect(r.tried).toBeTruthy();
      expect(r.result.denied).toBe(true);
      expect(r.result.asExpected).toBe(true);
      expect(typeof r.result.code).toBe('number');
      expect(r.result.codeName).toBeTruthy();
      expect(r.result.errmsg).toBeTruthy();
    }
    expect(results.map((r) => r.result.code)).toEqual([121, 13, 13, 13, 13]);
    expect(results[0]!.result.codeName).toBe('DocumentValidationFailure');
    expect(results[1]!.result.codeName).toBe('Unauthorized');

    const summary = events.find((e) => e.type === 'summary');
    expect(summary?.type === 'summary' && summary.summary).toMatchObject({ attempts: 5, denied: 5, allowed: 0, paid_cents: 0, ok: true });
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
