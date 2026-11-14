/**
 * Dashboard server. Reads as escrow_dashboard (find + changeStream on everything, no writes)
 * and serves the UI from one origin:
 *
 *   GET  /api/pipeline              S6: one card per ticket
 *   GET  /api/timeline/:traceId     S7: the $unionWith audit timeline
 *   GET  /ws/pipeline               live: the full pipeline after every change
 *   *    /api/login, /api/logout, /api/me, /api/reviews/...   forwarded to the approval service
 *   GET  /*                         the built React app (packages/web/dist)
 *
 * The dashboard never writes. Approving and rejecting go to the approval service, which
 * checks the session and runs as escrow_approver.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ChangeStream, Db, MongoClient } from 'mongodb';
import { WebSocketServer, type WebSocket } from 'ws';
import { ReviewService } from '@escrowops/api';
import { loadPipeline } from './pipeline.js';
import { loadTimeline } from './timeline.js';
import type { PipelineMessage } from './types.js';

export const DEFAULT_DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const WATCHED = ['agent_traces', 'intents', 'review_queue', 'approvals', 'approved', 'ledger', 'tickets'];
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface DashboardOptions {
  client: MongoClient;
  db: Db;
  /** Base URL of the approval service, e.g. http://127.0.0.1:4000. */
  approvalUrl: string;
  /** Built UI directory; omitted or missing means API only (use the Vite dev server). */
  distDir?: string;
  log?: (line: string) => void;
}

export async function buildDashboardServer(opts: DashboardOptions): Promise<FastifyInstance> {
  const log = opts.log ?? ((line) => console.log(`${new Date().toISOString()} ${line}`));
  const reviews = new ReviewService(opts.client, opts.db); // read-only use: toCards
  const app = Fastify({ logger: false });

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/pipeline', async () => ({ tickets: await loadPipeline(opts.db, reviews) }));
  app.get<{ Params: { traceId: string } }>('/api/timeline/:traceId', async (req) => ({
    trace_id: req.params.traceId,
    events: await loadTimeline(opts.db, req.params.traceId),
  }));

  // Approval routes go to the approval service unchanged, cookies included.
  const forward = async (req: FastifyRequest, reply: FastifyReply) => {
    const headers: Record<string, string> = {};
    for (const h of ['cookie', 'authorization', 'content-type']) {
      const v = req.headers[h];
      if (typeof v === 'string') headers[h] = v;
    }
    let res: Response;
    try {
      res = await fetch(new URL(req.url, opts.approvalUrl), {
        method: req.method,
        headers,
        ...(req.method === 'GET' || req.method === 'HEAD' || req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      });
    } catch {
      return reply.code(502).send({ error: 'approval_service_unreachable', message: `approval service not reachable at ${opts.approvalUrl}` });
    }
    const cookie = res.headers.get('set-cookie');
    if (cookie) reply.header('set-cookie', cookie);
    reply.code(res.status).header('content-type', res.headers.get('content-type') ?? 'application/json');
    return reply.send(await res.text());
  };
  for (const url of ['/api/login', '/api/logout', '/api/me', '/api/reviews', '/api/reviews/*']) {
    app.route({ method: ['GET', 'POST'], url, handler: forward });
  }

  // Live pipeline: one database-wide Change Stream, debounced, then the whole pipeline.
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  let latest: PipelineMessage | undefined;
  const send = (ws: WebSocket, msg: PipelineMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
  const refresh = async () => {
    latest = { type: 'pipeline', tickets: await loadPipeline(opts.db, reviews) };
    for (const ws of clients) send(ws, latest);
  };
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void refresh().catch((err) => log(`[dashboard] refresh failed: ${(err as Error).message}`)), 100);
  };

  let stream: ChangeStream | undefined;
  let stopped = false;
  const watch = async () => {
    while (!stopped) {
      stream = opts.db.watch([{ $match: { 'ns.coll': { $in: WATCHED } } }]);
      try {
        await stream.tryNext(); // establish now
        schedule();
        for await (const _change of stream) schedule();
      } catch (err) {
        if (!stopped) log(`[dashboard] change stream error, reopening: ${(err as Error).message}`);
      }
      await stream.close().catch(() => {});
      if (!stopped) await new Promise((r) => setTimeout(r, 1000));
    }
  };
  let watching: Promise<void> | undefined;

  app.server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws/pipeline') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      if (latest) send(ws, latest);
      else void refresh().catch(() => {});
    });
  });

  // The built UI, with index.html for client-side routes.
  const dist = opts.distDir ?? DEFAULT_DIST;
  if (existsSync(join(dist, 'index.html'))) {
    const root = resolve(dist);
    app.get('/*', async (req, reply) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
      let file = resolve(root, path);
      if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html');
      return reply.header('content-type', TYPES[extname(file)] ?? 'application/octet-stream').send(readFileSync(file));
    });
  } else {
    log(`[dashboard] no built UI in ${dist}; run npm run web:build, or use npm run web:dev`);
  }

  app.addHook('onReady', async () => {
    watching = watch();
  });
  app.addHook('onClose', async () => {
    stopped = true;
    clearTimeout(timer);
    for (const ws of clients) ws.terminate();
    wss.close();
    await stream?.close().catch(() => {});
    await watching?.catch(() => {});
  });
  return app;
}
