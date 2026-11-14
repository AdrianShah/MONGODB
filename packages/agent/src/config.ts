/**
 * Agent-only settings. The database connection comes from the shared config
 * (MONGODB_URI, MONGODB_DB, AGENT_DB_USER / AGENT_DB_PASSWORD).
 *
 * Model provider:
 *   AGENT_PROVIDER     groq | deepseek | anthropic.
 *                      Default: deepseek when DEEPSEEK_API_KEY is set, else groq when
 *                      GROQ_API_KEY is set, else anthropic.
 *   DEEPSEEK_API_KEY   DeepSeek key. Uses DeepSeek's Anthropic-compatible endpoint.
 *   GROQ_API_KEY       Groq key (free tier works; see groq.ts for the Groq-only knobs)
 *   ANTHROPIC_API_KEY  resolved by the Anthropic SDK (or an `ant auth login` profile)
 *
 *   AGENT_MODEL        default "deepseek-flash" on DeepSeek, "openai/gpt-oss-120b" on Groq,
 *                      "claude-sonnet-5-5" on Anthropic
 *   AGENT_EFFORT       low | medium | high | xhigh | max (default "medium")
 *   AGENT_CONCURRENCY  tickets worked in parallel by `npm run batch` (default 1 on Groq, to stay
 *                      inside free-tier tokens per minute; 4 otherwise)
 *   AGENT_FALLBACKS    "off" disables the server-side refusal fallback (Anthropic only; DeepSeek
 *                      never sends it)
 */
import type { Env } from '@escrowops/shared';
import type { Effort } from './agent.js';
import { GROQ_DEFAULT_MODEL } from './groq.js';

export type AgentProvider = 'groq' | 'deepseek' | 'anthropic';

export interface AgentSettings {
  provider: AgentProvider;
  model: string;
  effort: Effort;
  concurrency: number;
  fallbacks: boolean;
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const PROVIDERS: AgentProvider[] = ['groq', 'deepseek', 'anthropic'];

export class InvalidAgentEnvError extends Error {}

export function loadAgentSettings(env: Env = process.env): AgentSettings {
  const effort = (env['AGENT_EFFORT']?.trim() || 'medium') as Effort;
  if (!EFFORTS.includes(effort)) {
    throw new InvalidAgentEnvError(`AGENT_EFFORT must be one of ${EFFORTS.join(', ')} (got "${env['AGENT_EFFORT']}")`);
  }
  const explicit = env['AGENT_PROVIDER']?.trim().toLowerCase();
  if (explicit && !PROVIDERS.includes(explicit as AgentProvider)) {
    throw new InvalidAgentEnvError(`AGENT_PROVIDER must be one of ${PROVIDERS.join(', ')} (got "${env['AGENT_PROVIDER']}")`);
  }
  const provider: AgentProvider =
    (explicit as AgentProvider | undefined) ??
    (env['DEEPSEEK_API_KEY']?.trim() ? 'deepseek' : env['GROQ_API_KEY']?.trim() ? 'groq' : 'anthropic');
  const concurrency = Number(env['AGENT_CONCURRENCY']?.trim() || (provider === 'groq' ? 1 : 4));
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new InvalidAgentEnvError(`AGENT_CONCURRENCY must be a positive integer (got "${env['AGENT_CONCURRENCY']}")`);
  }
  const modelDefault = provider === 'groq' ? GROQ_DEFAULT_MODEL : provider === 'deepseek' ? 'deepseek-flash' : 'claude-sonnet-5-5';
  return {
    provider,
    model: env['AGENT_MODEL']?.trim() || modelDefault,
    effort,
    concurrency,
    fallbacks: provider === 'deepseek' ? false : env['AGENT_FALLBACKS']?.trim().toLowerCase() !== 'off',
  };
}
