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
 * Placeholders look like [ESTO] or [ ]. While any survive, the business facts
 * are not real, so the agent is not allowed to answer factual questions from
 * them — a model that sees "[USD]" in a price table will read it out.
 *
 * Returns distinct blanks: `[ ]` appears several times and counts once.
 */
function findPlaceholders(text: string): string[] {
  const cleaned = text
    // Instructions addressed to the developer or to Jordi, not to the model.
    .replace(/<!--[\s\S]*?-->/g, '')
    // Inline code, where the file explains the placeholder syntax itself
    // (`[CORCHETES]`); scanning it would report a permanently unfilled file.
    .replace(/`[^`\n]*`/g, '')
    .replace(/```[\s\S]*?```/g, '')
    // Markdown links: [texto](url) is content, not a blank to fill.
    .replace(/\[[^\]]*\]\([^)]*\)/g, '')
    // Checkbox lists, which are a normal markdown thing.
    .replace(/^\s*[-*]\s*\[[ xX]\]/gm, '');

  const matches = cleaned.match(/\[[^\]\n]{0,250}\]/g) ?? [];

  return [...new Set(matches.map((m) => m.replace(/\s+/g, ' ').trim()))];
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
            'La información del negocio todavía tiene datos sin llenar. Hasta completarla, el asistente pasa esas preguntas a ti en vez de responderlas.',
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
      'No se pudo leer el archivo de información del negocio. El asistente no sabe nada del negocio y va a pasarte todas las preguntas.',
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
