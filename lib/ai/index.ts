import { config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { MockProvider } from './mock.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { AiProvider } from './types.js';

let cached: AiProvider | null = null;

/**
 * Returns the configured AI provider, falling back to the mock when the chosen
 * one has no credentials.
 *
 * Falling back rather than throwing is deliberate: a missing key must degrade
 * the product to demo replies, not take the webhook down. The panel shows the
 * provider in use so the state is never a surprise.
 */
export function getProvider(): AiProvider {
  if (cached) return cached;

  const chosen: AiProvider =
    config.ai.provider === 'anthropic'
      ? new AnthropicProvider()
      : config.ai.provider === 'openai-compatible'
        ? new OpenAiCompatibleProvider()
        : new MockProvider();

  cached = chosen.isConfigured() ? chosen : new MockProvider();
  return cached;
}

/** False when replies are canned demo text rather than a real model's output. */
export function isRealProvider(): boolean {
  return getProvider().name !== 'mock';
}

/** Tests only. */
export function __setProvider(provider: AiProvider | null): void {
  cached = provider;
}

export * from './types.js';
export { estimateCostUsd, overCostCeiling } from './pricing.js';
