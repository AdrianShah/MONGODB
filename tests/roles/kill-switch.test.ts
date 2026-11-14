/**
 * Kill switch (packages/shared/src/killswitch.ts): "How do you stop or roll back an agent mid-run?"
 *
 * K1-K3  the freeze is a MongoDB privilege change: the agent's open connection gets 13, and
 *        unfreeze restores exactly roles.ts.
 * K4-K6  rollback: a voided intent never pays; in-flight and paid ones are never double-handled.
 * K7-K8  the freeze is audited and shows on the timeline; no runtime role can write the record.
 * K9     the agent loop stops the batch cleanly on 13.
 * K10    the approval-service endpoint: approvers only, actor from the session.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId, type Db, type Document, type MongoClient } from 'mongodb';
import {
  COLLECTIONS,
  ROLE_NAMES,
  agentRoleFrozen,
  applyRoles,
  connectAdmin,
  freezeAgent,
  loadFreezeStatus,
  roleDefinition,
  serverPrivileges,
  unfreezeAgent,
  type AgentTraceDoc,
  type KillSwitchDoc,
  type LedgerDoc,
} from '@escrowops/shared';
import { Executor, FakeProvider } from '@escrowops/executor';
import { resolveTicket, runBatch, type TicketResult } from '@escrowops/agent';
import { buildApiServer, DEFAULT_APPROVERS, type ApiServer } from '@escrowops/api';
import { loadTimeline } from '@escrowops/web';
import { ERROR_CODES, expectServerError, useTestDb } from '../helpers/index.js';
import { setUpAccess } from './role-helpers.js';
import { buildIntent } from '../../scripts/lib/redteam-attacks.js';
import { resetDatabase, seedDatabase } from '../../scripts/lib/seed-data.js';
import { abandonedPending, insertIntent, ledgerOf, seedOrder } from '../executor/fixtures.js';
import { proposeScript, scriptedModel } from '../agent/fake-model.js';
import { login } from '../api/fixtures.js';

const { UNAUTHORIZED } = ERROR_CODES;
const t = useTestDb('kill_switch');

let agent: Db;
let executor: Executor | undefined;
let provider: FakeProvider;

const ledger = () => ledgerOf(t().db);
const killSwitch = () => t().db.collection<KillSwitchDoc>(COLLECTIONS.kill_switch);

/** Sorted "collection:action" pairs, for comparing a role on the server to its definition. */
function privilegeSet(privileges: Array<{ resource: { collection?: string }; actions: string[] }>): string[] {
  return privileges.flatMap((p) => p.actions.map((a) => `${p.resource.collection ?? ''}:${a}`)).sort();
}
async function agentPrivilegesOnServer(): Promise<string[]> {
  const info = await t().db.command({ rolesInfo: { role: ROLE_NAMES.agent, db: t().dbName }, showPrivileges: true });
  return privilegeSet(((info['roles'] as Document[])[0]!['privileges'] ?? []) as never);
}

async function startExecutor(): Promise<Executor> {
  const client = await t().connectAsRole('executor');
  executor = new Executor({ db: client.db(t().dbName), provider, log: () => {}, retryBaseMs: 10, staleReconcileEveryMs: 0 });
  await executor.start();
  return executor;
}

const freeze = (reason = 'test freeze') => freezeAgent(t().admin, t().dbName, { actor: 'approver-a', reason });

beforeAll(async () => {
  await setUpAccess(t());
  await seedDatabase(t().db);
  // Opened BEFORE any freeze and kept open: the freeze must reach a running agent.
  agent = (await t().connectAsRole('agent')).db(t().dbName);
});
beforeEach(async () => {
  await applyRoles(t().admin, t().dbName); // unfrozen
  await resetDatabase(t().db);
  provider = new FakeProvider();
});
afterEach(async () => {
  await executor?.stop();
  executor = undefined;
});

describe('K1-K3 the freeze is a database privilege change', () => {
  it('K1: a frozen agent insert on intents and review_queue is rejected by the server with 13, on an already-open connection', async () => {
    // Works before the freeze.
    await agent.collection(COLLECTIONS.intents).insertOne(buildIntent({ amount_cents: 1_000, trace_id: 'tr-k1-before' }));

    await freeze();
    expect(await agentRoleFrozen(t().admin, t().dbName)).toBe(true);

    await expectServerError(
      () => agent.collection(COLLECTIONS.intents).insertOne(buildIntent({ amount_cents: 1_000, trace_id: 'tr-k1-after' })),
      UNAUTHORIZED,
    );
    await expectServerError(
      () => agent.collection(COLLECTIONS.review_queue).insertOne({ ...buildIntent({ amount_cents: 90_000, trace_id: 'tr-k1-rq' }), status: 'pending' }),
      UNAUTHORIZED,
    );
    // It can still read and still record why it stopped.
    expect(await agent.collection(COLLECTIONS.tickets).findOne({})).not.toBeNull();
    await agent
      .collection(COLLECTIONS.agent_traces)
      .insertOne({ trace_id: 'tr-k1', ticket_id: 'T-1001', seq: 0, kind: 'error', text: 'frozen', created_at: new Date() });
    expect(await t().db.collection(COLLECTIONS.intents).countDocuments({ trace_id: 'tr-k1-after' })).toBe(0);
  });

  it('K2: a frozen agent cannot unfreeze itself or touch the kill switch record', async () => {
    await freeze();
    await expectServerError(() => agent.command({ updateRole: ROLE_NAMES.agent, privileges: [], roles: [] }), UNAUTHORIZED);
    await expectServerError(() => agent.collection(COLLECTIONS.kill_switch).insertOne({ action: 'unfreeze' }), UNAUTHORIZED);
    await expectServerError(() => agent.collection(COLLECTIONS.kill_switch).deleteMany({}), UNAUTHORIZED);
    expect(await agentRoleFrozen(t().admin, t().dbName)).toBe(true);
  });

  it('K3: unfreeze restores exactly the privileges in roles.ts, and the agent can write again', async () => {
    const defined = privilegeSet(serverPrivileges(roleDefinition('agent'), t().dbName));
    expect(await agentPrivilegesOnServer()).toEqual(defined);

    await freeze();
    const frozen = await agentPrivilegesOnServer();
    expect(frozen).not.toContain(`${COLLECTIONS.intents}:insert`);
    expect(frozen).not.toContain(`${COLLECTIONS.review_queue}:insert`);
    expect(frozen).toContain(`${COLLECTIONS.agent_traces}:insert`);

    await unfreezeAgent(t().admin, t().dbName, { actor: 'approver-b', reason: 'incident over' });
    expect(await agentPrivilegesOnServer()).toEqual(defined);
    expect(await agentRoleFrozen(t().admin, t().dbName)).toBe(false);
    // applyRoles agrees: nothing to change.
    expect((await applyRoles(t().admin, t().dbName)).unchanged).toContain(`role:${ROLE_NAMES.agent}`);
    await agent.collection(COLLECTIONS.intents).insertOne(buildIntent({ amount_cents: 1_000, trace_id: 'tr-k3-after' }));
  });
});

describe('K4-K6 rollback', () => {
  it('K4: an intent proposed before the freeze and not yet paid is voided and never pays', async () => {
    const order = await seedOrder(t().db);
    const intent = await insertIntent(t().db, order, 4_200);

    const record = await freeze();
    expect(record.voided.map((v) => v.source_id)).toEqual([`intents:${intent._id.toHexString()}`]);

    // The executor starts after the freeze: its sweep and the stream both find the slot taken.
    await startExecutor();
    await executor!.idle();
    expect(provider.calls).toHaveLength(0);
    const entry = (await t().db.collection<LedgerDoc>(COLLECTIONS.ledger).findOne({ source_doc_id: intent._id }))!;
    expect(entry.status).toBe('failed');
    expect(entry.failure_reason).toMatch(/^voided_by_kill_switch/);
    expect(entry.voided_by).toEqual(record._id);

    // A second executor claim on the same source is refused by the unique index.
    await expectServerError(() => t().db.collection(COLLECTIONS.ledger).insertOne({ ...entry, _id: new ObjectId(), status: 'pending' }), 11000);
  });

  it('K5: a pending payout that has not passed its checks is voided by compare-and-set and never pays', async () => {
    const order = await seedOrder(t().db);
    const intent = await insertIntent(t().db, order, 4_200);
    await ledger().insertOne(abandonedPending(intent, { checks_passed: false, attempts: 0 }));

    const record = await freeze();
    expect(record.voided).toMatchObject([{ how: 'pending_unchecked', ticket_id: intent.ticket_id }]);

    await startExecutor(); // reconciles pending entries on start
    await executor!.idle();
    expect(provider.calls).toHaveLength(0);
    expect((await ledger().findOne({ source_doc_id: intent._id }))?.status).toBe('failed');
  });

  it('K6: a paid intent is never touched, and one already past its checks is reported in flight and paid exactly once', async () => {
    const order = await seedOrder(t().db);
    const paid = await insertIntent(t().db, order, 1_000);
    await startExecutor();
    await executor!.idle();
    await expect.poll(async () => (await ledger().findOne({ source_doc_id: paid._id }))?.status).toBe('succeeded');
    await executor!.stop();
    executor = undefined;
    const paidBefore = await ledger().findOne({ source_doc_id: paid._id });

    const inFlight = await insertIntent(t().db, order, 2_000);
    await ledger().insertOne(abandonedPending(inFlight, { checks_passed: true, attempts: 1 }));

    const record = await freeze();
    expect(record.voided).toEqual([]);
    expect(record.in_flight.map((v) => v.ticket_id)).toEqual([inFlight.ticket_id]);
    expect(await ledger().findOne({ source_doc_id: paid._id })).toEqual(paidBefore);

    const callsBefore = provider.calls.length;
    await startExecutor();
    await executor!.idle();
    expect(provider.calls.length - callsBefore).toBe(1); // the in-flight one, once
    expect((await ledger().findOne({ source_doc_id: inFlight._id }))?.status).toBe('succeeded');
    expect(await ledger().countDocuments({ source_doc_id: paid._id })).toBe(1);
  });
});

describe('K7-K8 audit', () => {
  it('K7: the freeze writes one kill_switch record with who, when, why, what was revoked and what was voided', async () => {
    const order = await seedOrder(t().db);
    const a = await insertIntent(t().db, order, 1_500);
    const b = await insertIntent(t().db, order, 2_500);
    const before = Date.now();
    const record = await freeze('prompt injection suspected');

    const docs = await killSwitch().find().toArray();
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      action: 'freeze',
      actor: 'approver-a',
      reason: 'prompt injection suspected',
      role: ROLE_NAMES.agent,
      privileges_changed: [
        { collection: COLLECTIONS.intents, actions: ['insert'] },
        { collection: COLLECTIONS.review_queue, actions: ['insert'] },
      ],
      already: false,
    });
    expect(docs[0]!.at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(docs[0]!.voided.map((v) => v.intent_id.toHexString()).sort()).toEqual([a._id, b._id].map((id) => id.toHexString()).sort());
    expect(docs[0]!.voided_trace_ids.sort()).toEqual([a.trace_id, b.trace_id].sort());
    expect(record._id).toEqual(docs[0]!._id);

    // The read-only dashboard sees the state; no runtime role can write the record.
    const dashboard = (await t().connectAsRole('dashboard')).db(t().dbName);
    expect(await loadFreezeStatus(dashboard)).toMatchObject({ frozen: true, last: { actor: 'approver-a' } });
    for (const role of ['agent', 'approver', 'executor', 'dashboard'] as const) {
      const db = (await t().connectAsRole(role)).db(t().dbName);
      await expectServerError(() => db.collection(COLLECTIONS.kill_switch).insertOne({ action: 'unfreeze' }), UNAUTHORIZED);
      await expectServerError(() => db.collection(COLLECTIONS.kill_switch).updateMany({}, { $set: { reason: 'x' } }), UNAUTHORIZED);
    }

    await unfreezeAgent(t().admin, t().dbName, { actor: 'approver-b' });
    expect(await loadFreezeStatus(dashboard)).toMatchObject({ frozen: false, last: { action: 'unfreeze', actor: 'approver-b' } });
  });

  it('K8: the audit timeline of a voided refund shows the freeze and the void, and no payout start', async () => {
    const order = await seedOrder(t().db);
    const intent = await insertIntent(t().db, order, 1_500);
    await freeze('stop');
    const dashboard = (await t().connectAsRole('dashboard')).db(t().dbName);
    const { events } = await loadTimeline(dashboard, intent.trace_id);
    const kinds = events.map((e) => `${e.source}:${e.kind}`);
    expect(kinds).toContain('kill_switch:frozen');
    expect(kinds).toContain('ledger:failed');
    expect(kinds).not.toContain('ledger:pending');
    expect(events.find((e) => e.source === 'kill_switch')?.summary).toMatch(/FROZEN by approver-a: stop/);
  });
});

describe('K9 the agent stops cleanly', () => {
  it('K9: a frozen agent returns "frozen", records the 13 in its trace, and the batch takes no more tickets', async () => {
    await freeze();
    const { createMessage } = scriptedModel([
      ...proposeScript('T-1001', 'O-5101', 8900),
      ...proposeScript('T-1002', 'O-5102', 1000),
    ]);
    const seen: TicketResult[] = [];
    let skipped: string[] = [];
    const results = await runBatch(['T-1001', 'T-1002', 'T-1003'], {
      db: agent,
      createMessage,
      model: 'fake',
      concurrency: 1,
      onResult: (r) => seen.push(r),
      onFrozen: (s) => (skipped = s),
    });
    expect(results.map((r) => r.status)).toEqual(['frozen']);
    expect(results[0]!.detail).toMatch(/code 13/);
    expect(skipped).toEqual(['T-1002', 'T-1003']);
    expect(await t().db.collection(COLLECTIONS.intents).countDocuments()).toBe(0);
    const last = await t()
      .db.collection<AgentTraceDoc>(COLLECTIONS.agent_traces)
      .find({ trace_id: results[0]!.trace_id })
      .sort({ seq: -1 })
      .limit(1)
      .next();
    expect(last).toMatchObject({ kind: 'error', tool: 'propose_refund' });
  });

  it('K9: after unfreeze the same ticket proposes normally', async () => {
    await freeze();
    await unfreezeAgent(t().admin, t().dbName, { actor: 'approver-a' });
    const { createMessage } = scriptedModel(proposeScript('T-1001', 'O-5101', 8900));
    expect((await resolveTicket('T-1001', { db: agent, createMessage, model: 'fake' })).status).toBe('proposed');
  });
});

describe('K10 approval service endpoint', () => {
  let api: ApiServer;
  let token: string;
  let apiAdmin: MongoClient[] = [];

  beforeAll(async () => {
    const client = await t().connectAsRole('approver');
    api = await buildApiServer({
      client,
      db: client.db(t().dbName),
      approvers: DEFAULT_APPROVERS,
      log: () => {},
      killSwitch: {
        dbName: t().dbName,
        connectAdmin: async () => {
          const c = await connectAdmin(t().config);
          apiAdmin.push(c);
          return c;
        },
      },
    });
    await api.app.ready();
    token = await login(api.app, 'approver-a');
  });
  afterAll(async () => {
    await api?.app.close();
    await Promise.all(apiAdmin.map((c) => c.close().catch(() => undefined)));
    apiAdmin = [];
  });

  it('K10: freeze and unfreeze need an approver session', async () => {
    for (const url of ['/api/freeze', '/api/unfreeze']) {
      expect((await api.app.inject({ method: 'POST', url, payload: {} })).statusCode).toBe(401);
    }
    expect((await api.app.inject({ method: 'GET', url: '/api/freeze' })).statusCode).toBe(401);
    expect(await agentRoleFrozen(t().admin, t().dbName)).toBe(false);
  });

  it('K10: an approver freezes (actor from the session, not the body) and unfreezes', async () => {
    const auth = { authorization: `Bearer ${token}` };
    const res = await api.app.inject({ method: 'POST', url: '/api/freeze', headers: auth, payload: { reason: 'demo' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ frozen: true, record: { actor: 'approver-a', reason: 'demo' } });
    // An actor in the body is dropped: the record names the session's approver.
    const spoof = await api.app.inject({ method: 'POST', url: '/api/freeze', headers: auth, payload: { actor: 'mallory' } });
    expect(spoof.json()).toMatchObject({ record: { actor: 'approver-a', already: true } });
    expect((await api.app.inject({ method: 'GET', url: '/api/freeze', headers: auth })).json()).toMatchObject({ frozen: true });
    await expectServerError(
      () => agent.collection(COLLECTIONS.intents).insertOne(buildIntent({ amount_cents: 1_000, trace_id: 'tr-k10' })),
      UNAUTHORIZED,
    );

    const un = await api.app.inject({ method: 'POST', url: '/api/unfreeze', headers: auth, payload: {} });
    expect(un.statusCode).toBe(200);
    expect(await agentRoleFrozen(t().admin, t().dbName)).toBe(false);
    expect(apiAdmin.length).toBeGreaterThan(0);
  });

  it('K10: without an admin path configured the routes answer 503', async () => {
    const client = await t().connectAsRole('approver');
    const bare = await buildApiServer({ client, db: client.db(t().dbName), approvers: DEFAULT_APPROVERS, log: () => {} });
    await bare.app.ready();
    try {
      const tok = await login(bare.app, 'approver-a');
      const res = await bare.app.inject({ method: 'POST', url: '/api/freeze', headers: { authorization: `Bearer ${tok}` }, payload: {} });
      expect(res.statusCode).toBe(503);
    } finally {
      await bare.app.close();
    }
  });
});
