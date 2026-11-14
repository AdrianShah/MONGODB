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
 *
 * Every route except login and health needs a session (cookie, or `Authorization: Bearer`).
 * The approver is whoever owns the session; an `approver_id` in a body is ignored (S1, I17).
 */
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ObjectId, type Db, type MongoClient } from 'mongodb';
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
