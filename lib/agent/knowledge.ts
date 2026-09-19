import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../logger.js';

/**
 * Loads `knowledge/business.md` (SPEC §5.1).
 *
 * This file is the agent's only source of facts about the business. Jordi edits
 * it and redeploys; he never touches prompt code.
 */

let cache: { text: string; unfilled: string[] } | null = null;

/**
 * Placeholders look like «esto». While any survive, the business facts are not
 * real, so the agent is not allowed to answer factual questions from them.
 */
function findPlaceholders(text: string): string[] {
  const matches = text.match(/«[^»]{0,80}»/g) ?? [];
  return [...new Set(matches)];
}

function candidatePaths(): string[] {
  return [
    join(process.cwd(), 'knowledge/business.md'),
    // Vercel unpacks the function bundle under a task root that is not cwd in
    // every runtime version; try the module-relative path as well.
    new URL('../../knowledge/business.md', import.meta.url).pathname,
  ];
}

export function loadKnowledge(): { text: string; unfilled: string[] } {
  if (cache) return cache;

  for (const path of candidatePaths()) {
    try {
      const text = readFileSync(path, 'utf8');
      const unfilled = findPlaceholders(text);
      if (unfilled.length) {
        log.warn('knowledge.placeholders_remaining', {
          count: unfilled.length,
          human:
            'The business information file still has blanks to fill in. Until it is complete the assistant will hand those questions to Jordi instead of answering them.',
        });
      }
      cache = { text, unfilled };
      return cache;
    } catch {
      // try the next candidate
    }
  }

  log.error('knowledge.missing', {
    human:
      'The business information file could not be read. The assistant knows nothing about the business and will hand every question to Jordi.',
  });
  cache = { text: '', unfilled: ['«archivo no encontrado»'] };
  return cache;
}

/** True when the knowledge file is complete enough to quote facts from. */
export function knowledgeIsComplete(): boolean {
  const { text, unfilled } = loadKnowledge();
  return text.length > 0 && unfilled.length === 0;
}

/** Tests only. */
export function __setKnowledge(value: { text: string; unfilled: string[] } | null): void {
  cache = value;
}
