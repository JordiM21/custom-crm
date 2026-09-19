/**
 * Message pacing (SPEC §5.4).
 *
 * An instant, perfectly formed reply is the clearest tell that a parent is
 * talking to software. Everything here exists to make the reply arrive the way
 * a busy person's would.
 */

export const MIN_DELAY_MS = 8_000;
export const MAX_DELAY_MS = 45_000;
export const BASE_DELAY_MS = 2_000;
export const MS_PER_CHAR = 30;

/** Hard cap, enforced in code rather than in the prompt (SPEC §5.4). */
export const MAX_MESSAGES_PER_INBOUND = 2;

export function computeDelayMs(replyLength: number): number {
  const raw = BASE_DELAY_MS + replyLength * MS_PER_CHAR;
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, raw));
}

/** 2–5 seconds between two messages in the same burst. */
export function interMessageGapMs(): number {
  return 2_000 + Math.floor(Math.random() * 3_000);
}

/**
 * Splits a model reply into at most two WhatsApp messages.
 *
 * Splits on blank lines only — a reply already written as short lines stays one
 * message. Anything beyond the cap is dropped rather than queued: the previous
 * system's failure mode was bombarding leads, and a parent who receives three
 * messages for one question stops replying.
 */
export function splitReply(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const parts = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  if (parts.length <= 1) return [trimmed];
  return parts.slice(0, MAX_MESSAGES_PER_INBOUND);
}

/** Send times for a burst, relative to now. */
export function scheduleBurst(messages: string[], from = Date.now()): { body: string; sendAfter: string }[] {
  let cursor = from;
  return messages.map((body, index) => {
    cursor += index === 0 ? computeDelayMs(body.length) : interMessageGapMs();
    return { body, sendAfter: new Date(cursor).toISOString() };
  });
}
