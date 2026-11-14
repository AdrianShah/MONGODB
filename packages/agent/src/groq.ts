/**
 * Groq as the agent's model (free tier friendly). Groq serves an OpenAI-compatible
 * Chat Completions API with tool calling, so this adapter translates the agent loop's
 * Messages-shaped request into a chat completion and the reply back into a Messages-shaped
 * response. The loop, the tools, the trace, recording and replay are unchanged.
 *
 *   GROQ_API_KEY        required (https://console.groq.com/keys, free)
 *   AGENT_MODEL         default "openai/gpt-oss-120b"
 *   GROQ_MAX_TOKENS     completion cap per call (default 2048; keeps free-tier TPM usage low)
 *   GROQ_BASE_URL       default "https://api.groq.com/openai/v1"
 *
 * Rate limits (HTTP 429) are retried after the `retry-after` the server sends, a
 * malformed tool call from the model (400 `tool_use_failed`) is retried as a new sample,
 * and a network failure or a request stalled past 60s is aborted and retried with backoff.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { CreateMessage, Effort } from './agent.js';

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

export const GROQ_DEFAULT_MODEL = 'openai/gpt-oss-120b';
export const GROQ_DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

export interface GroqOptions {
  apiKey: string;
  baseUrl?: string;
  /** Completion token cap per call (Groq's free tier counts it against tokens per minute). */
  maxTokens?: number;
  /** Retries for 429 / 5xx / tool_use_failed / network errors before giving up. */
  maxRetries?: number;
  /** Per-request timeout; a stalled request is aborted and retried (default 60s). */
  timeoutMs?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface ChatResponse {
  id?: string;
  model?: string;
  choices: Array<{
    finish_reason: string | null;
    message: { content?: string | null; reasoning?: string | null; tool_calls?: ChatToolCall[] | null };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class GroqError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GroqError';
  }
}

const asText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: { type?: string; text?: string }) => (b?.type === 'text' ? (b.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
};

/** Messages-shaped request -> chat completion messages. */
export function toChatMessages(params: Pick<CreateParams, 'system' | 'messages'>): ChatMessage[] {
  const out: ChatMessage[] = [];
  const system = typeof params.system === 'string' ? params.system : asText(params.system ?? []);
  if (system) out.push({ role: 'system', content: system });

  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content } as ChatMessage);
      continue;
    }
    const blocks = m.content as unknown as Array<Record<string, unknown>>;
    if (m.role === 'assistant') {
      const tool_calls: ChatToolCall[] = blocks
        .filter((b) => b['type'] === 'tool_use')
        .map((b) => ({
          id: String(b['id']),
          type: 'function',
          function: { name: String(b['name']), arguments: JSON.stringify(b['input'] ?? {}) },
        }));
      const text = asText(blocks);
      out.push({ role: 'assistant', content: text || null, ...(tool_calls.length ? { tool_calls } : {}) });
      continue;
    }
    // user turn: tool results become `tool` messages, any text a user message
    for (const b of blocks) {
      if (b['type'] === 'tool_result') {
        const body = typeof b['content'] === 'string' ? b['content'] : asText(b['content']);
        out.push({ role: 'tool', tool_call_id: String(b['tool_use_id']), content: b['is_error'] ? `Error: ${body}` : body });
      }
    }
    const text = asText(blocks);
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

/** Messages tool definitions -> chat completion function tools (`strict` is dropped). */
export function toChatTools(tools: CreateParams['tools']) {
  return (tools ?? []).map((t) => {
    const tool = t as { name: string; description?: string; input_schema?: unknown };
    return {
      type: 'function' as const,
      function: { name: tool.name, description: tool.description ?? '', parameters: tool.input_schema ?? { type: 'object', properties: {} } },
    };
  });
}

/** Chat completion -> Messages-shaped response the agent loop reads. */
export function fromChatResponse(res: ChatResponse, model: string): Message {
  const choice = res.choices[0];
  const msg = choice?.message ?? {};
  const content: Array<Record<string, unknown>> = [];
  if (msg.reasoning?.trim()) content.push({ type: 'thinking', thinking: msg.reasoning, signature: '' });
  if (msg.content?.trim()) content.push({ type: 'text', text: msg.content, citations: null });
  for (const call of msg.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      input = { _unparsed_arguments: call.function.arguments };
    }
    content.push({ type: 'tool_use', id: call.id, name: call.function.name, input });
  }
  const hasTools = content.some((b) => b['type'] === 'tool_use');
  const stop_reason = hasTools ? 'tool_use' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  return {
    id: res.id ?? 'groq',
    type: 'message',
    role: 'assistant',
    model: res.model ?? model,
    content,
    stop_reason,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? 0 },
  } as unknown as Message;
}

const REASONING_EFFORT: Record<Effort, 'low' | 'medium' | 'high'> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

/** Seconds from `retry-after`, else from Groq's "try again in 1.5s" / "in 750ms" message. */
function retryAfterMs(headers: Headers, body: string, attempt: number): number {
  const header = Number(headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.ceil(header * 1000) + 250;
  const m = /try again in (?:(\d+)m)?([\d.]+)(ms|s)/i.exec(body);
  if (m) return Math.ceil((Number(m[1] ?? 0) * 60 + Number(m[2]) / (m[3] === 'ms' ? 1000 : 1)) * 1000) + 250;
  return Math.min(30_000, 1000 * 2 ** attempt);
}

export function groqCreateMessage(opts: GroqOptions): CreateMessage {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = (opts.baseUrl ?? GROQ_DEFAULT_BASE_URL).replace(/\/$/, '');
  const maxRetries = opts.maxRetries ?? 6;
  const log = opts.log ?? ((line: string) => console.warn(line));
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return async (params) => {
    const effort = (params as { output_config?: { effort?: Effort } }).output_config?.effort;
    const body = {
      model: params.model,
      messages: toChatMessages(params),
      tools: toChatTools(params.tools),
      tool_choice: 'auto',
      temperature: 0.2,
      max_completion_tokens: Math.min(params.max_tokens, opts.maxTokens ?? 2048),
      // gpt-oss: reasoning effort is low | medium | high, and parallel tool calls are unsupported.
      ...(/gpt-oss/.test(params.model) ? { parallel_tool_calls: false, ...(effort ? { reasoning_effort: REASONING_EFFORT[effort] } : {}) } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          // A stalled connection must not hang the batch: abort and retry it.
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // Network failure or timeout (fetch throws rather than returning a status).
        if (attempt >= maxRetries) throw new GroqError(0, `Groq request failed after ${attempt + 1} attempts: ${(err as Error).message}`);
        const wait = Math.min(30_000, 1000 * 2 ** attempt);
        log(`[agent] groq network error (${(err as Error).name}: ${(err as Error).message}); retrying in ${(wait / 1000).toFixed(1)}s`);
        await sleep(wait);
        continue;
      }
      if (res.ok) return fromChatResponse((await res.json()) as ChatResponse, params.model);

      const text = await res.text();
      const toolCallFailed = res.status === 400 && /tool_use_failed|failed to call a function/i.test(text);
      const retriable = res.status === 429 || res.status >= 500 || toolCallFailed;
      if (!retriable || attempt >= maxRetries) {
        throw new GroqError(res.status, `Groq ${res.status}: ${text.slice(0, 500)}`);
      }
      const wait = toolCallFailed ? 250 : retryAfterMs(res.headers, text, attempt);
      log(`[agent] groq ${res.status}${toolCallFailed ? ' (malformed tool call)' : res.status === 429 ? ' (rate limited)' : ''}; retrying in ${(wait / 1000).toFixed(1)}s`);
      await sleep(wait);
    }
  };
}
