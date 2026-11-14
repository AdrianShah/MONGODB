/**
 * Agent-only settings. The database connection comes from the shared config
 * (MONGODB_URI, MONGODB_DB, AGENT_DB_USER / AGENT_DB_PASSWORD). Claude
 * credentials are resolved by the Anthropic SDK (ANTHROPIC_API_KEY, or an
 * `ant auth login` profile).
 *
 *   AGENT_MODEL        default "claude-sonnet-5-5" (PRD section 10)
 *   AGENT_EFFORT       low | medium | high | xhigh | max (default "medium")
 *   AGENT_CONCURRENCY  tickets worked in parallel by `npm run batch` (default 4)
 *   AGENT_FALLBACKS    "off" disables the server-side refusal fallback
 */
import type { Env } from '@escrowops/shared';
import type { Effort } from './agent.js';

export interface AgentSettings {
  model: string;
  effort: Effort;
  concurrency: number;
  fallbacks: boolean;
}

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export class InvalidAgentEnvError extends Error {}

export function loadAgentSettings(env: Env = process.env): AgentSettings {
  const effort = (env['AGENT_EFFORT']?.trim() || 'medium') as Effort;
  if (!EFFORTS.includes(effort)) {
    throw new InvalidAgentEnvError(`AGENT_EFFORT must be one of ${EFFORTS.join(', ')} (got "${env['AGENT_EFFORT']}")`);
  }
  const concurrency = Number(env['AGENT_CONCURRENCY']?.trim() || 4);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new InvalidAgentEnvError(`AGENT_CONCURRENCY must be a positive integer (got "${env['AGENT_CONCURRENCY']}")`);
  }
  return {
    model: env['AGENT_MODEL']?.trim() || 'claude-sonnet-5-5',
    effort,
    concurrency,
    fallbacks: env['AGENT_FALLBACKS']?.trim().toLowerCase() !== 'off',
  };
}
