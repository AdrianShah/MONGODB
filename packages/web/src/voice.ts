/**
 * Voice for approvers (ElevenLabs text-to-speech), served by the dashboard server.
 *
 *   GET /api/voice/config                     { elevenlabs, approver }: which voice the UI can use
 *   GET /api/voice/review/:id                 { text, audio }: the spoken review card
 *   GET /api/voice/review/:id/audio           audio/mpeg of that text (ElevenLabs)
 *   GET /api/voice/timeline/:traceId          { text, audio }: the spoken audit trail
 *   GET /api/voice/timeline/:traceId/audio    audio/mpeg of that text (ElevenLabs)
 *
 * Voice is read-only. It reads what the dashboard already shows and never approves anything:
 * approving still takes an authenticated click that goes to the approval service. Every voice
 * route needs an approver session, even with DASHBOARD_PUBLIC=1, because audio costs credits.
 *
 * The ElevenLabs key stays in this process. The browser only ever gets script text and audio
 * bytes. Without a key `audio` is null and the UI speaks the text with speechSynthesis.
 * Scripts are deterministic templates (no LLM), and audio is cached by a hash of
 * (voice, model, text), so a card is synthesized once per version: a new approval changes
 * the text and therefore the cache key.
 */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId, type Db } from 'mongodb';
import { COLLECTIONS, type ChainCheck } from '@escrowops/shared';
import type { ReviewService } from '@escrowops/api';
import type { ReviewCard } from '@escrowops/api/card';
import { loadTimeline } from './timeline.js';
import type { TimelineEvent } from './types.js';

export const ELEVENLABS_URL = 'https://api.elevenlabs.io';
/** "George", one of ElevenLabs' default voices; ELEVENLABS_VOICE_ID overrides it. */
export const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb';
export const DEFAULT_VOICE_MODEL = 'eleven_flash_v2_5';
const MAX_CHARS = 2500;
const CACHE_ENTRIES = 64;

export interface VoiceOptions {
  /** ElevenLabs API key. Unset means browser speech only. */
  apiKey?: string;
  voiceId?: string;
  model?: string;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** Voice settings from the environment (ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL). */
export function voiceOptionsFromEnv(env: NodeJS.ProcessEnv): VoiceOptions {
  const pick = (name: string) => env[name]?.trim() || undefined;
  const apiKey = pick('ELEVENLABS_API_KEY');
  const voiceId = pick('ELEVENLABS_VOICE_ID');
  const model = pick('ELEVENLABS_MODEL');
  return { ...(apiKey ? { apiKey } : {}), ...(voiceId ? { voiceId } : {}), ...(model ? { model } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Scripts. Pure functions of what the dashboard already shows.

const TIER_SPOKEN: Record<string, string> = {
  single_agent: 'auto refund',
  peer_review: 'peer review, one approver required',
  human_required: 'dual control, two different approvers required',
  blocked: 'over the hard cap',
};

/** 500000 -> "5,000 dollars"; 129950 -> "1,299 dollars and 50 cents". */
export function spokenDollars(cents: unknown): string {
  if (typeof cents !== 'number' || !Number.isFinite(cents)) return 'an unknown amount';
  const whole = Math.floor(Math.abs(cents) / 100);
  const rest = Math.abs(cents) % 100;
  const d = `${whole.toLocaleString('en-US')} ${whole === 1 ? 'dollar' : 'dollars'}`;
  return rest ? `${d} and ${rest} ${rest === 1 ? 'cent' : 'cents'}` : d;
}

const sentence = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t && !/[.!?]$/.test(t) ? `${t}.` : t;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, '')}…` : s);
const list = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
const words = (id: string) => id.replace(/_/g, ' ');
const finish = (parts: string[]) => {
  const text = parts.map(sentence).filter(Boolean).join(' ');
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
};

/** What "Listen" reads for a review card. */
export function reviewScript(card: ReviewCard): string {
  const approvers = card.approvals.filter((a) => a.decision === 'approve').map((a) => a.approver_id);
  const rejecters = card.approvals.filter((a) => a.decision === 'reject').map((a) => a.approver_id);
  const parts = [
    `Review for ticket ${card.ticket_id}`,
    `The agent proposes a refund of ${spokenDollars(card.amount_cents)} on order ${card.order_id}`,
    `Tier: ${TIER_SPOKEN[card.tier] ?? words(card.tier)}`,
    `Approval progress: ${card.approved_count} of ${card.required_approvals}${approvers.length ? `, approved by ${list(approvers)}` : ''}`,
    rejecters.length ? `Rejected by ${list(rejecters)}` : '',
    card.status !== 'pending' ? `This review is ${card.status}` : '',
    `The agent's reason: ${clip(card.reason, 500)}`,
  ];
  const evidence = card.evidence.slice(0, 5).map((e) => [words(e.kind), e.ref, e.note].filter(Boolean).join(', '));
  if (evidence.length) parts.push(`Evidence: ${evidence.map(sentence).join(' ')}`);
  if (card.evidence.length > 5) parts.push(`And ${card.evidence.length - 5} more evidence items on screen`);
  parts.push(
    card.rules_broken.length
      ? `MongoDB refused it as an auto refund. Validator rule broken: ${list(card.rules_broken)}`
      : 'No validator rule is recorded for this review',
  );
  if (card.promotion_error) parts.push(`The approved collection's validator refused promotion: ${card.promotion_error}`);
  parts.push('Listening approves nothing. To decide, use the Approve or Reject button');
  return finish(parts);
}

/** What "Narrate audit trail" reads: ticket, tool calls, validator decision, approvers, payout. */
export function timelineScript(input: { ticket_id?: string; events: TimelineEvent[]; integrity?: ChainCheck }): string {
  const parts = [`Audit trail for ticket ${input.ticket_id ?? 'unknown'}`];
  const detail = (e: TimelineEvent) => (e.detail ?? {}) as Record<string, unknown>;
  const tools: string[] = [];
  const flushTools = () => {
    if (!tools.length) return;
    parts.push(`The agent made ${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}: ${list(tools.map(words))}`);
    tools.length = 0;
  };
  for (const e of input.events) {
    const d = detail(e);
    if (e.source === 'agent_traces' && e.kind === 'tool_call') {
      tools.push(String(d['tool'] ?? 'a tool'));
      continue;
    }
    if (e.source === 'agent_traces' && (e.kind === 'tool_result' || e.kind === 'reasoning')) continue;
    flushTools();
    const rules = (d['rules_broken'] as string[] | undefined) ?? [];
    switch (`${e.source}:${e.kind}`) {
      case 'agent_traces:decision': {
        const out = (d['output'] ?? {}) as Record<string, unknown>;
        if (out['status'] === 'declined') parts.push(`The agent declined the refund: ${clip(String(out['reason'] ?? ''), 300)}`);
        else if (out['status'] === 'held') parts.push(`The agent proposed ${spokenDollars(out['amount_cents'])}, and MongoDB refused it as an auto refund`);
        else if (out['status'] === 'proposed') parts.push(`The agent proposed ${spokenDollars(out['amount_cents'])}, and the validator accepted it as an auto refund`);
        else parts.push(`The agent's decision: ${words(String(out['status'] ?? 'unknown'))}`);
        break;
      }
      case 'agent_traces:error':
        parts.push('The agent reported an error');
        break;
      case 'intents:proposed':
        parts.push(`An auto refund of ${spokenDollars(d['amount_cents'])} was written to intents`);
        break;
      case 'review_queue:held':
        parts.push(
          `The validator held ${spokenDollars(d['amount_cents'])} for review${rules.length ? `, rule broken: ${list(rules)}` : ''}. ` +
            `Tier: ${TIER_SPOKEN[String(d['tier'])] ?? words(String(d['tier']))}`,
        );
        break;
      case 'review_queue:blocked':
        parts.push(`The approved collection's validator refused promotion${rules.length ? `, rule ${list(rules)}` : ''}. The review is blocked`);
        break;
      case 'review_queue:rejected':
        parts.push('The review was rejected');
        break;
      case 'approvals:approve':
        parts.push(`${d['approver_id']} approved`);
        break;
      case 'approvals:reject':
        parts.push(`${d['approver_id']} rejected`);
        break;
      case 'approved:promoted':
        parts.push(`Promoted to approved by ${list(((d['approvers'] as string[] | undefined) ?? []).map(String))}`);
        break;
      case 'ledger:pending':
        parts.push(`The executor started the payout of ${spokenDollars(d['amount_cents'])}`);
        break;
      case 'ledger:succeeded':
        parts.push(`Paid. ${d['provider']} refund ID ${d['provider_refund_id']}`);
        break;
      case 'ledger:failed':
        parts.push(`The payout failed: ${d['failure_reason']}`);
        break;
      default:
        break; // e.g. review_queue:approved, which "promoted" already covers
    }
  }
  flushTools();
  if (input.integrity) {
    parts.push(
      input.integrity.ok
        ? `Hash chain verified: ${input.integrity.checked} records unchanged since they were written`
        : `Warning: the hash chain does not verify. ${input.integrity.problems.length} problems found`,
    );
  }
  return finish(parts);
}

// ---------------------------------------------------------------------------------------------
// ElevenLabs, with a small cache.

export class VoiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Speaker {
  private readonly cache = new Map<string, Promise<Buffer>>();
  /** Number of ElevenLabs requests made, for tests and logs. */
  calls = 0;

  constructor(private readonly opts: VoiceOptions) {}

  get enabled(): boolean {
    return !!this.opts.apiKey;
  }

  /** Cache key for a text: changes with the voice, the model and every word of the script. */
  key(text: string): string {
    return createHash('sha256')
      .update(`${this.opts.voiceId ?? DEFAULT_VOICE_ID}\n${this.opts.model ?? DEFAULT_VOICE_MODEL}\n${text}`)
      .digest('hex')
      .slice(0, 16);
  }

  async speak(text: string): Promise<Buffer> {
    if (!this.opts.apiKey) throw new VoiceError(503, 'voice_unavailable', 'no ElevenLabs key configured; use browser speech');
    const key = this.key(text);
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // refresh LRU position
      this.cache.set(key, hit);
      return hit;
    }
    const pending = this.synthesize(text);
    this.cache.set(key, pending);
    pending.catch(() => this.cache.delete(key)); // never cache a failure
    while (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return pending;
  }

  private async synthesize(text: string): Promise<Buffer> {
    this.calls++;
    const voiceId = encodeURIComponent(this.opts.voiceId ?? DEFAULT_VOICE_ID);
    const url = `${this.opts.baseUrl ?? ELEVENLABS_URL}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(url, {
        method: 'POST',
        headers: { 'xi-api-key': this.opts.apiKey!, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: this.opts.model ?? DEFAULT_VOICE_MODEL }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new VoiceError(502, 'voice_failed', 'ElevenLabs not reachable; use browser speech');
    }
    // The upstream body is not passed on: it is not needed, and nothing about the key can leak.
    if (!res.ok) throw new VoiceError(502, 'voice_failed', `ElevenLabs returned HTTP ${res.status}; use browser speech`);
    return Buffer.from(await res.arrayBuffer());
  }
}

// ---------------------------------------------------------------------------------------------
// Routes.

export interface VoiceRouteDeps {
  db: Db;
  reviews: ReviewService;
  /** The approver who owns the request's session, or null. */
  whoIs: (headers: FastifyRequest['headers']) => Promise<string | null>;
  voice?: VoiceOptions;
  log: (line: string) => void;
}

export function registerVoiceRoutes(app: FastifyInstance, deps: VoiceRouteDeps): Speaker {
  const speaker = new Speaker(deps.voice ?? {});
  const approverOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await deps.whoIs(req.headers))) {
      return reply.code(401).send({ error: 'unauthenticated', message: 'voice is for signed-in approvers' });
    }
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof VoiceError) return reply.code(err.status).send({ error: err.code, message: err.message });
    throw err;
  };

  const reviewText = async (raw: string) => {
    if (!ObjectId.isValid(raw)) throw new VoiceError(404, 'not_found', 'review not found');
    try {
      return reviewScript(await deps.reviews.get(new ObjectId(raw)));
    } catch (err) {
      if ((err as { status?: number }).status === 404) throw new VoiceError(404, 'not_found', 'review not found');
      throw err;
    }
  };
  const timelineText = async (traceId: string) => {
    const { events, integrity } = await loadTimeline(deps.db, traceId);
    if (!events.length) throw new VoiceError(404, 'not_found', 'no events for this trace');
    const trace = await deps.db.collection(COLLECTIONS.agent_traces).findOne({ trace_id: traceId }, { projection: { ticket_id: 1 } });
    return timelineScript({ ticket_id: trace?.['ticket_id'] as string | undefined, events, integrity });
  };

  app.get('/api/voice/config', async (req) => ({ elevenlabs: speaker.enabled, approver: !!(await deps.whoIs(req.headers)) }));

  const routes: Array<[string, (param: string) => Promise<string>]> = [
    ['/api/voice/review/:param', reviewText],
    ['/api/voice/timeline/:param', timelineText],
  ];
  for (const [path, script] of routes) {
    app.get<{ Params: { param: string } }>(path, { preHandler: approverOnly }, async (req, reply) => {
      try {
        const text = await script(req.params.param);
        const audio = speaker.enabled ? `${req.url.split('?')[0]}/audio?v=${speaker.key(text)}` : null;
        return { text, audio };
      } catch (err) {
        return fail(reply, err);
      }
    });
    app.get<{ Params: { param: string } }>(`${path}/audio`, { preHandler: approverOnly }, async (req, reply) => {
      try {
        const audio = await speaker.speak(await script(req.params.param));
        return reply.header('content-type', 'audio/mpeg').header('cache-control', 'private, max-age=3600').send(audio);
      } catch (err) {
        if (err instanceof VoiceError && err.code === 'voice_failed') deps.log(`[dashboard] voice: ${err.message}`);
        return fail(reply, err);
      }
    });
  }
  return speaker;
}
