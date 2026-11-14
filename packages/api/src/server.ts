/**
 * The approval service's HTTP and WebSocket API.
 *
 *   POST /api/login              { approver_id, password } -> session cookie
 *   POST /api/logout
 *   GET  /api/me
 *   GET  /api/reviews?status=    pending (default) | approved | rejected | blocked | all
 *   GET  /api/reviews/:id
 *   POST /api/reviews/:id/approve  { note? }
 *   POST /api/reviews/:id/reject   { note? }
 *   GET  /ws                     snapshot of pending reviews, then every review change
 *   GET  /api/agent/status           kill switch status, read from the intents validator on the server
 *   POST /api/agent/freeze   { reason? }  freeze the agent (validator + role), void unpaid refunds
 *   POST /api/agent/unfreeze { reason? }  restore validators (active policy) and role (roles.ts)
 *   (/api/freeze, /api/unfreeze and GET /api/freeze are aliases)
 *
 * Every route except login and health needs a session (cookie, or `Authorization: Bearer`).
 * The approver is whoever owns the session; an `approver_id` in a body is ignored (S1, I17).
 */
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
import {
  agentFrozen,
  freezeAgent,
  loadFreezeStatus,
  unfreezeAgent,
  type KillSwitchDoc,
} from '@escrowops/shared';
import { WebSocketServer, type WebSocket } from 'ws';
import { ApproverDirectory, SessionStore, type ApproverAccount } from './approvers.js';
import { ReviewFeed } from './feed.js';
import { ReviewError, ReviewService, type FaultHook, type ReviewStatus } from './reviews.js';

export const SESSION_COOKIE = 'escrowops_session';
const STATUSES = ['pending', 'approved', 'rejected', 'blocked', 'all'] as const;

export interface ApiOptions {
  client: MongoClient;
  db: Db;
  approvers: readonly ApproverAccount[];
  log?: (line: string) => void;
  /** Test hook (C10). */
  fault?: FaultHook;
  /**
   * Kill switch. The approval service itself runs as escrow_approver, which cannot collMod;
   * freeze and unfreeze open a short-lived admin connection (MONGODB_URI) for the operation
   * and close it. Omitted: the freeze routes answer 503. `revokeRole: false` skips updateRole.
   */
  killSwitch?: { connectAdmin: () => Promise<MongoClient>; dbName: string; revokeRole?: boolean };
}

export interface ApiServer {
  app: FastifyInstance;
  reviews: ReviewService;
  feed: ReviewFeed;
  sessions: SessionStore;
}

function tokenFrom(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

export async function buildApiServer(opts: ApiOptions): Promise<ApiServer> {
  const log = opts.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`));
  const directory = new ApproverDirectory(opts.approvers);
  const sessions = new SessionStore();
  const reviews = new ReviewService(opts.client, opts.db, opts.fault);
  const feed = new ReviewFeed(opts.db, reviews, log);
  const app = Fastify({ logger: false });

  const approverOf = (req: FastifyRequest) => sessions.approverFor(tokenFrom(req.raw));
  const requireApprover = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!approverOf(req)) return reply.code(401).send({ error: 'unauthenticated', message: 'log in first' });
  };
  const reviewId = (raw: string): ObjectId => {
    if (!ObjectId.isValid(raw)) throw new ReviewError(404, 'not_found', 'review not found');
    return new ObjectId(raw);
  };

  app.setErrorHandler((caught, _req, reply) => {
    if (caught instanceof ReviewError) return reply.code(caught.status).send({ error: caught.code, message: caught.message });
    const err = caught as Error & { statusCode?: number };
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    log(`[api] ${err.stack ?? err.message}`);
    return reply.code(500).send({ error: 'internal', message: 'internal error' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.post<{ Body: { approver_id: string; password: string } }>(
    '/api/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['approver_id', 'password'],
          properties: { approver_id: { type: 'string', maxLength: 100 }, password: { type: 'string', maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const id = directory.verify(req.body.approver_id, req.body.password);
      if (!id) return reply.code(401).send({ error: 'bad_credentials', message: 'wrong approver ID or password' });
      const token = sessions.create(id);
      reply.header('set-cookie', `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);
      return { approver_id: id, token };
    },
  );

  app.post('/api/logout', async (req, reply) => {
    sessions.delete(tokenFrom(req.raw));
    reply.header('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireApprover }, async (req) => ({ approver_id: approverOf(req) }));

  app.get<{ Querystring: { status?: (typeof STATUSES)[number] } }>(
    '/api/reviews',
    {
      preHandler: requireApprover,
      schema: { querystring: { type: 'object', properties: { status: { type: 'string', enum: [...STATUSES] } } } },
    },
    async (req) => ({ reviews: await reviews.list((req.query.status ?? 'pending') as ReviewStatus | 'all') }),
  );

  app.get<{ Params: { id: string } }>('/api/reviews/:id', { preHandler: requireApprover }, async (req) =>
    reviews.get(reviewId(req.params.id)),
  );

  const decisionSchema = {
    body: {
      type: ['object', 'null'],
      // Anything else, including approver_id, is dropped: the approver comes from the session.
      additionalProperties: false,
      properties: { note: { type: 'string', maxLength: 1000 } },
    },
  };
  for (const action of ['approve', 'reject'] as const) {
    app.post<{ Params: { id: string }; Body: { note?: string } | null }>(
      `/api/reviews/:id/${action}`,
      { preHandler: requireApprover, schema: decisionSchema },
      async (req) => {
        const approver = approverOf(req)!;
        const id = reviewId(req.params.id);
        const note = req.body?.note;
        const result = action === 'approve' ? await reviews.approve(id, approver, note) : await reviews.reject(id, approver, note);
        log(`[api] ${approver} ${action}d review ${id.toHexString()} (ticket ${result.card.ticket_id}): ${result.outcome}`);
        return result;
      },
    );
  }

  // Kill switch: authenticated approvers only; the actor is the session's approver.
  const reasonSchema = {
    body: { type: ['object', 'null'], additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } },
  };
  let killSwitchBusy = false;
  const withAdmin = async <T>(reply: FastifyReply, fn: (admin: MongoClient, dbName: string) => Promise<T>): Promise<T | FastifyReply> => {
    const ks = opts.killSwitch;
    if (!ks) return reply.code(503).send({ error: 'kill_switch_unavailable', message: 'the kill switch is not configured on this approval service' });
    const admin = await ks.connectAdmin();
    try {
      return await fn(admin, ks.dbName);
    } finally {
      await admin.close().catch(() => undefined);
    }
  };
  const summarize = (doc: KillSwitchDoc) => ({
    id: doc._id.toHexString(),
    action: doc.action,
    actor: doc.actor,
    reason: doc.reason,
    at: doc.at,
    voided: doc.voided.map((v) => ({ source_id: v.source_id, ticket_id: v.ticket_id, amount_cents: v.amount_cents })),
    voided_reviews: (doc.voided_reviews ?? []).map((v) => ({ review_id: v.review_id.toHexString(), ticket_id: v.ticket_id, amount_cents: v.amount_cents })),
    in_flight: doc.in_flight,
    enforcement: doc.enforcement,
    role_revoked: doc.role_revoked,
    role_note: doc.role_note,
    already: doc.already,
  });

  const status = async (_req: FastifyRequest, reply: FastifyReply) =>
    withAdmin(reply, async (admin, dbName) => {
      const { last } = await loadFreezeStatus(admin.db(dbName));
      return { frozen: await agentFrozen(admin.db(dbName)), last: last ? summarize(last) : null };
    });
  app.get('/api/agent/status', { preHandler: requireApprover }, status);
  app.get('/api/freeze', { preHandler: requireApprover }, status);
  for (const [action, url] of [
    ['freeze', '/api/agent/freeze'],
    ['unfreeze', '/api/agent/unfreeze'],
    ['freeze', '/api/freeze'],
    ['unfreeze', '/api/unfreeze'],
  ] as const) {
    app.post<{ Body: { reason?: string } | null }>(url, { preHandler: requireApprover, schema: reasonSchema }, async (req, reply) => {
      if (killSwitchBusy) return reply.code(409).send({ error: 'busy', message: 'a freeze or unfreeze is already running' });
      killSwitchBusy = true;
      try {
        const actor = approverOf(req)!;
        return await withAdmin(reply, async (admin, dbName) => {
          const doc = await (action === 'freeze' ? freezeAgent : unfreezeAgent)(admin, dbName, {
            actor,
            reason: req.body?.reason,
            revokeRole: opts.killSwitch?.revokeRole ?? true,
          });
          log(
            action === 'freeze'
              ? `[api] KILL SWITCH: ${actor} froze the agent (${doc.reason}); voided ${doc.voided.length} unpaid intent(s) and ${doc.voided_reviews.length} pending review(s), ${doc.in_flight.length} in flight; enforced by ${doc.enforcement.join(' + ')}`
              : `[api] KILL SWITCH: ${actor} unfroze the agent (${doc.reason})`,
          );
          return { frozen: action === 'freeze', record: summarize(doc) };
        });
      } finally {
        killSwitchBusy = false;
      }
    });
  }

  // S2: WebSocket feed, authenticated with the same session.
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  feed.subscribe((card) => {
    const msg = JSON.stringify({ type: 'review', review: card });
    for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(msg);
  });
  app.server.on('upgrade', (req, socket, head) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== '/ws' || !sessions.approverFor(tokenFrom(req))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      // Snapshot after subscribing, so nothing between the two is lost; clients merge by id.
      reviews
        .list('pending')
        .then((list) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'snapshot', reviews: list })))
        .catch((err) => log(`[api] snapshot failed: ${(err as Error).message}`));
    });
  });

  app.addHook('onReady', async () => {
    await feed.start();
  });
  app.addHook('onClose', async () => {
    for (const ws of clients) ws.terminate();
    wss.close();
    await feed.stop();
  });

  return { app, reviews, feed, sessions };
}
