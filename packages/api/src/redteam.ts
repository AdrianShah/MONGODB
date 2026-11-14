/**
 * POST /api/redteam/run: the dashboard's "Run red team" button (DEMO.md 1:55).
 *
 * Runs the five demo attacks from @escrowops/shared/redteam with the AGENT's own database
 * credentials, never the approval service's: `connect` opens a fresh agent connection and a
 * read-only (dashboard) connection for each run and both are closed afterwards. Before any
 * attack, `runRedTeam` asks the server (connectionStatus) who the attacking connection is and
 * refuses unless it holds exactly `agent_role`.
 *
 * Needs an approver session. Single-flight (409 while a run is in progress) and rate-limited
 * (429 with Retry-After until `cooldownMs` after the last start). The response is a
 * Server-Sent Events stream, one event per RedTeamStreamEvent, as each attack happens:
 *
 *   event: start    { approver, run_id, username, db, attacks }
 *   event: attempt  { index, id }
 *   event: result   { index, id, label, tried, result: { code, codeName, errmsg, ... } }
 *   event: summary  { summary: { attempts, denied, paid_cents, landed, ok, ... } }
 *   event: error    { message }   (instead of summary, if the run itself failed)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from 'mongodb';
import { runRedTeam, type RedTeamStreamEvent } from '@escrowops/shared/redteam';

/** Connections for one run. */
export interface RedTeamConnections {
  /** Logged in as the agent user, and nothing else. */
  agentDb: Db;
  /** A read-only identity (the dashboard user), for the R4 target and the footprint check. */
  readDb: Db;
  /** The agent username from config, checked against the server's answer. */
  agentUsername?: string;
  close(): Promise<void>;
}

export interface RedTeamOptions {
  /** Opens fresh connections for one run. */
  connect: () => Promise<RedTeamConnections>;
  /** Minimum time between two runs. Default 10 s. */
  cooldownMs?: number;
  /** Pause between attacks so the panel animates. Default 600 ms. */
  pauseMs?: number;
}

export function registerRedTeam(
  app: FastifyInstance,
  opts: RedTeamOptions | undefined,
  deps: {
    approverOf: (req: FastifyRequest) => string | undefined;
    requireApprover: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    log: (line: string) => void;
  },
): void {
  const cooldownMs = opts?.cooldownMs ?? 10_000;
  let running = false;
  let lastStart = 0;

  app.post('/api/redteam/run', { preHandler: deps.requireApprover }, async (req, reply) => {
    if (!opts) return reply.code(503).send({ error: 'redteam_disabled', message: 'red-team runs are not enabled on this approval service' });
    if (running) return reply.code(409).send({ error: 'redteam_running', message: 'a red-team run is already in progress' });
    const wait = lastStart + cooldownMs - Date.now();
    if (wait > 0) {
      return reply
        .code(429)
        .header('retry-after', String(Math.ceil(wait / 1000)))
        .send({ error: 'redteam_cooldown', message: `wait ${Math.ceil(wait / 1000)} s before the next run` });
    }
    running = true;
    lastStart = Date.now();
    const approver = deps.approverOf(req)!;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const send = (event: RedTeamStreamEvent) => {
      if (!raw.writableEnded) raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    let conns: RedTeamConnections | undefined;
    try {
      conns = await opts.connect();
      const { summary } = await runRedTeam({
        agentDb: conns.agentDb,
        readDb: conns.readDb,
        ...(conns.agentUsername ? { agentUsername: conns.agentUsername } : {}),
        pauseMs: opts.pauseMs ?? 600,
        onEvent: (e) => send(e.type === 'start' ? { ...e, approver } : e),
      });
      deps.log(
        `[api] ${approver} ran the red team (${summary.run_id}): ${summary.attempts} attempts, ${summary.denied} denied, ${summary.paid_cents} cents paid${summary.ok ? '' : `; PROBLEMS: ${summary.problems.join('; ')}`}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[api] red-team run by ${approver} failed: ${message}`);
      send({ type: 'error', message });
    } finally {
      running = false;
      await conns?.close().catch(() => {});
      raw.end();
    }
  });
}
