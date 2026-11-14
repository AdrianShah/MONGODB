/** Builds the live model call for the configured provider (config.ts): DeepSeek, Groq, or Anthropic. */
import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '@escrowops/shared';
import { DEEPSEEK_ANTHROPIC_BASE_URL, anthropicCreateMessage, deepseekCreateMessage, type CreateMessage } from './agent.js';
import { InvalidAgentEnvError, type AgentSettings } from './config.js';
import { groqCreateMessage } from './groq.js';

export function liveCreateMessage(settings: Pick<AgentSettings, 'provider'>, env: Env = process.env): CreateMessage {
  if (settings.provider === 'deepseek') {
    const apiKey = env['DEEPSEEK_API_KEY']?.trim();
    if (!apiKey) throw new InvalidAgentEnvError('AGENT_PROVIDER is deepseek but DEEPSEEK_API_KEY is not set');
    return deepseekCreateMessage(new Anthropic({ apiKey, baseURL: DEEPSEEK_ANTHROPIC_BASE_URL }));
  }
  if (settings.provider === 'groq') {
    const apiKey = env['GROQ_API_KEY']?.trim();
    if (!apiKey) throw new InvalidAgentEnvError('AGENT_PROVIDER is groq but GROQ_API_KEY is not set (get a free key at https://console.groq.com/keys)');
    const maxTokens = Number(env['GROQ_MAX_TOKENS']?.trim() || 2048);
    return groqCreateMessage({
      apiKey,
      ...(env['GROQ_BASE_URL']?.trim() ? { baseUrl: env['GROQ_BASE_URL'].trim() } : {}),
      ...(Number.isInteger(maxTokens) && maxTokens > 0 ? { maxTokens } : {}),
    });
  }
  return anthropicCreateMessage(new Anthropic());
}

/** True when a live model is configured (used by evals to choose live vs replay). */
export function hasLiveModelKey(env: Env = process.env): boolean {
  return Boolean(env['DEEPSEEK_API_KEY']?.trim() || env['GROQ_API_KEY']?.trim() || env['ANTHROPIC_API_KEY']?.trim());
}
