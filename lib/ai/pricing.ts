import { config } from '../config.js';

/**
 * Cost estimation for the per-lead spend ceiling (SPEC §9).
 *
 * These are estimates, not billing. Set AI_PRICE_IN_PER_MTOK and
 * AI_PRICE_OUT_PER_MTOK from whichever provider is chosen — the defaults are
 * deliberately pessimistic so an unconfigured deployment over-counts spend and
 * escalates early rather than running up a bill silently.
 */

const DEFAULT_IN_PER_MTOK = 3;
const DEFAULT_OUT_PER_MTOK = 15;

function price(name: string, fallback: number): number {
  const v = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  const inRate = price('AI_PRICE_IN_PER_MTOK', DEFAULT_IN_PER_MTOK);
  const outRate = price('AI_PRICE_OUT_PER_MTOK', DEFAULT_OUT_PER_MTOK);
  return (inputTokens / 1_000_000) * inRate + (outputTokens / 1_000_000) * outRate;
}

/** True when this lead has cost more than the configured ceiling. */
export function overCostCeiling(spentUsd: number): boolean {
  return config.ai.costCeilingUsd > 0 && spentUsd >= config.ai.costCeilingUsd;
}
