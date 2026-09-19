import type { AiMessage } from '../ai/types.js';
import { assistantText, userText } from '../ai/types.js';
import type { Lead, Message } from '../store/types.js';

/** SPEC §5.5 — the model sees at most this many turns verbatim. */
export const HISTORY_LIMIT = 30;

/**
 * Maps stored messages to conversation turns.
 *
 * `outbound_human` is mapped to `assistant` on purpose: what Jordi already told
 * this parent is part of what "our side" has said, and the agent contradicting
 * it is worse than the agent not knowing it.
 *
 * Consecutive turns with the same role are merged — most providers reject an
 * alternating-role violation, and a parent sending three messages in a row is
 * the normal case on WhatsApp.
 */
export function buildHistory(messages: Message[]): AiMessage[] {
  const turns: AiMessage[] = [];

  for (const message of messages) {
    const body = message.body?.trim();
    if (!body) continue;

    const role = message.direction === 'inbound' ? 'user' : 'assistant';
    const previous = turns.at(-1);

    if (previous && previous.role === role) {
      const block = previous.content.at(-1);
      if (block && block.type === 'text') {
        block.text = `${block.text}\n${body}`;
        continue;
      }
    }

    turns.push(role === 'user' ? userText(body) : assistantText(body));
  }

  return turns;
}

/**
 * A summary of the turns that did not fit, prepended to the system prompt.
 *
 * Deliberately deterministic rather than a second model call: it costs nothing,
 * cannot hallucinate, and the facts that matter (names, age, stage) are already
 * stored as columns on the lead. The point is that the model knows the
 * conversation is longer than what it can see — SPEC §5.5 forbids silent
 * truncation.
 */
export function summariseOlder(lead: Lead, older: Message[]): string | undefined {
  if (older.length === 0) return undefined;

  const inbound = older.filter((m) => m.direction === 'inbound').length;
  const fromJordi = older.filter((m) => m.direction === 'outbound_human').length;

  const known: string[] = [];
  if (lead.display_name) known.push(`el padre/madre se llama ${lead.display_name}`);
  if (lead.student_name) known.push(`el estudiante se llama ${lead.student_name}`);
  if (lead.student_age !== null) known.push(`tiene ${lead.student_age} años`);
  if (lead.notes) known.push(`notas internas: ${lead.notes}`);

  const started = new Date(lead.first_contact_at).toISOString().slice(0, 10);

  const parts = [
    `Esta conversación empezó el ${started} y ya tiene ${older.length} mensajes anteriores a los que ves abajo`,
    `(${inbound} del padre/madre${fromJordi ? `, ${fromJordi} escritos por Jordi en persona` : ''}).`,
  ];

  if (known.length) {
    parts.push(`De lo ya conversado sabes que ${known.join(', ')}.`);
  }

  parts.push('No vuelvas a preguntar nada de eso.');

  return parts.join(' ');
}

/** Splits stored messages into the recent window and everything before it. */
export function splitHistory(messages: Message[]): { recent: Message[]; older: Message[] } {
  if (messages.length <= HISTORY_LIMIT) return { recent: messages, older: [] };
  return {
    recent: messages.slice(-HISTORY_LIMIT),
    older: messages.slice(0, messages.length - HISTORY_LIMIT),
  };
}
