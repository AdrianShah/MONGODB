/**
 * POST /api/redteam/run (the dashboard's red-team panel) on the approval service: needs an
 * approver session, attacks with the agent's credentials only, streams the same results
 * `npm run redteam` prints, writes nothing, and is single-flight and rate-limited.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { MongoClient } from 'mongodb';
import { COLLECTIONS, type IntentDoc } from '@escrowops/shared';
import { buildIntent, formatAttackLine, type RedTeamStreamEvent } from '@escrowops/shared/redteam';
import { buildApiServer, DEFAULT_APPROVERS, type ApiServer, type RedTeamOptions } from '@escrowops/api';
import { useTestDb } from '../helpers/index.js';
import { setUpAccess } from '../roles/role-helpers.js';
import { seedDatabase } from '../../scripts/lib/seed-data.js';
import { login } from './fixtures.js';

const run = promisify(execFile);
const t = useTestDb('redteam');
const servers: ApiServer[] = [];
let connects = 0;

/** Fresh agent + dashboard connections per run, like packages/api/src/main.ts. */
function connectAsAgent(): RedTeamOptions['connect'] {
  return async () => {
    connects += 1;
    const agent = await t().connectAsRole('agent');
    const reader = await t().connectAsRole('dashboard');
    return {
      agentDb: agent.db(t().dbName),
      readDb: reader.db(t().dbName),
      agentUsername: t().config.users.agent.username,
      close: async () => void (await Promise.all([agent.close(), reader.close()])),
    };
  };
}

async function server(redteam: RedTeamOptions | undefined): Promise<ApiServer> {
  const client: MongoClient = await t().connectAsRole('approver');
  const api = await buildApiServer({
    client,
    db: client.db(t().dbName),
    approvers: DEFAULT_APPROVERS,
    log: () => {},
    ...(redteam ? { redteam } : {}),
  });
  await api.app.ready();
  servers.push(api);
  return api;
}

function parseSse(body: string): RedTeamStreamEvent[] {
  return body
    .split('\n\n')
    .filter((chunk) => chunk.trim())
    .map((chunk) => {
      const lines = chunk.split('\n');
      const type = lines.find((l) => l.startsWith('event: '))!.slice(7);
      const event = JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)) as RedTeamStreamEvent;
      expect(event.type).toBe(type);
      return event;
    });
}

const runVia = (api: ApiServer, token?: string) =>
  api.app.inject({ method: 'POST', url: '/api/redteam/run', headers: token ? { authorization: `Bearer ${token}` } : {}, payload: {} });

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const c of [COLLECTIONS.intents, COLLECTIONS.approved, COLLECTIONS.ledger, COLLECTIONS.approvals, COLLECTIONS.review_queue]) {
    out[c] = await t().db.collection(c).countDocuments();
  }
  return out;
}

let target: IntentDoc;

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
  // An earlier, legitimate proposal for R4 to try to edit.
  target = buildIntent({ amount_cents: 12_000, trace_id: 'trace-redteam-target' });
  await t().db.collection<IntentDoc>(COLLECTIONS.intents).insertOne(target);
});
afterAll(async () => {
  for (const s of servers) await s.app.close();
});

describe('POST /api/redteam/run', () => {
  it('needs an approver session, and opens no agent connection without one', async () => {
    const api = await server({ connect: connectAsAgent(), cooldownMs: 0, pauseMs: 0 });
    const before = connects;
    expect((await runVia(api)).statusCode).toBe(401);
    expect((await runVia(api, 'forged-token')).statusCode).toBe(401);
    expect(connects).toBe(before);
  });

  it('answers 503 when the service was started without red-team connections', async () => {
    const api = await server(undefined);
    const res = await runVia(api, await login(api.app, 'approver-a'));
    expect(res.statusCode).toBe(503);
  });

  it('streams five denials with the server codes, then a scoreboard checked against the ledger, and writes nothing', async () => {
    const api = await server({ connect: connectAsAgent(), cooldownMs: 0, pauseMs: 0 });
    const before = await counts();
    const res = await runVia(api, await login(api.app, 'approver-a'));
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/event-stream/);

    const events = parseSse(res.body);
    expect(events.map((e) => e.type)).toEqual(['start', ...Array<string[]>(5).fill(['attempt', 'result']).flat(), 'summary']);
    const start = events[0] as Extract<RedTeamStreamEvent, { type: 'start' }>;
    expect(start).toMatchObject({ approver: 'approver-a', username: 'escrow_agent', db: t().dbName });
    expect(start.attacks.map((a) => a.id)).toEqual(['R1', 'R2', 'R4', 'R5', 'R6']);

    const results = events.filter((e): e is Extract<RedTeamStreamEvent, { type: 'result' }> => e.type === 'result');
    expect(results.map((r) => [r.result.code, r.result.codeName])).toEqual([
      [121, 'DocumentValidationFailure'],
      [13, 'Unauthorized'],
      [13, 'Unauthorized'],
      [13, 'Unauthorized'],
      [13, 'Unauthorized'],
    ]);
    for (const r of results) {
      expect(r.result).toMatchObject({ denied: true, asExpected: true });
      expect(r.tried).toBeTruthy();
      expect(r.result.errmsg).toBeTruthy();
    }

    const summary = (events.at(-1) as Extract<RedTeamStreamEvent, { type: 'summary' }>).summary;
    expect(summary).toMatchObject({
      attempts: 5,
      denied: 5,
      allowed: 0,
      paid_cents: 0,
      landed: { approved: 0, ledger: 0, intents: 0 },
      target_edited: false,
      ok: true,
      problems: [],
    });

    expect(await counts()).toEqual(before);
    const after = await t().db.collection<IntentDoc>(COLLECTIONS.intents).findOne({ _id: target._id });
    expect(after?.amount_cents).toBe(12_000);
    expect(await t().db.collection(COLLECTIONS.intents).countDocuments({ trace_id: summary.run_id })).toBe(0);
  });

  it('streams exactly the lines `npm run redteam` prints', async () => {
    const api = await server({ connect: connectAsAgent(), cooldownMs: 0, pauseMs: 0 });
    const panel = parseSse((await runVia(api, await login(api.app, 'approver-b'))).body)
      .filter((e): e is Extract<RedTeamStreamEvent, { type: 'result' }> => e.type === 'result')
      .map((e) => formatAttackLine(e.index + 1, e.label, e.result));

    const users = t().config.users;
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      MONGODB_URI: t().uri,
      MONGODB_DB: t().dbName,
      MONGODB_ROLE_AUTH_SOURCE: t().dbName,
      AGENT_DB_USER: users.agent.username,
      AGENT_DB_PASSWORD: users.agent.password,
      DASHBOARD_DB_USER: users.dashboard.username,
      DASHBOARD_DB_PASSWORD: users.dashboard.password,
    };
    const cli = await run(process.execPath, ['--import', 'tsx', 'scripts/redteam.ts', '--fast'], { env, cwd: process.cwd() });
    const lines = cli.stdout.split('\n').filter((l) => /^\d\. /.test(l));
    expect(lines).toEqual(panel);
    expect(cli.stdout).toMatch(/Payouts caused: 0/);
  });

  it('refuses to attack with anything but the agent identity', async () => {
    const api = await server({
      cooldownMs: 0,
      pauseMs: 0,
      // A misconfiguration: the approver's credentials handed in as the "agent".
      connect: async () => {
        const approver = await t().connectAsRole('approver');
        const reader = await t().connectAsRole('dashboard');
        return { agentDb: approver.db(t().dbName), readDb: reader.db(t().dbName), close: async () => {} };
      },
    });
    const before = await counts();
    const events = parseSse((await runVia(api, await login(api.app, 'approver-a'))).body);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', message: expect.stringMatching(/agent_role/) });
    expect(await counts()).toEqual(before);
  });

  it('is single-flight (409) and rate-limited (429)', async () => {
    const api = await server({ connect: connectAsAgent(), cooldownMs: 60_000, pauseMs: 150 });
    const token = await login(api.app, 'approver-a');
    const first = runVia(api, token);
    await new Promise((r) => setTimeout(r, 50));
    const second = await runVia(api, token);
    expect(second.statusCode).toBe(409);
    expect((await first).statusCode).toBe(200);
    const third = await runVia(api, token);
    expect(third.statusCode).toBe(429);
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });
});
