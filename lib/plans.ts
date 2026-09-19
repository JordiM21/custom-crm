import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from './logger.js';

/**
 * The plans the agent is allowed to offer (SPEC §6).
 *
 * Plan ids come from here, never from the model. An unknown id is an error the
 * model sees, so it escalates instead of inventing a price.
 */

export interface Plan {
  id: string;
  label: string;
  description: string;
  stripePriceId: string;
  monthlyUsd: number;
  /** False for a one-off payment like the Plan Inicial. */
  recurring?: boolean;
}

let cache: Plan[] | null = null;

function candidatePaths(): string[] {
  return [
    join(process.cwd(), 'config/plans.json'),
    new URL('../config/plans.json', import.meta.url).pathname,
  ];
}

export function loadPlans(): Plan[] {
  if (cache) return cache;

  for (const path of candidatePaths()) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { plans?: Plan[] };
      cache = parsed.plans ?? [];
      return cache;
    } catch {
      // try the next candidate
    }
  }

  log.error('plans.missing', {
    human: 'No se pudo leer el archivo de planes. El asistente no puede mandar links de pago.',
  });
  cache = [];
  return cache;
}

export function findPlan(id: string): Plan | null {
  return loadPlans().find((p) => p.id === id) ?? null;
}

/** Plan ids the model may pass, for the tool schema. */
export function planIds(): string[] {
  return loadPlans().map((p) => p.id);
}

/** Tests only. */
export function __setPlans(plans: Plan[] | null): void {
  cache = plans;
}
