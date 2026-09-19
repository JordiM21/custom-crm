/**
 * Minimal typings for the WhatsApp Cloud API webhook payload.
 *
 * Deliberately loose: Meta adds fields without notice, and an unknown field
 * must never crash the webhook. Anything unrecognised is logged (SPEC §4.3)
 * rather than dropped silently.
 */

export interface WebhookReferral {
  source_url?: string;
  source_id?: string;
  source_type?: string;
  headline?: string;
  body?: string;
  ctwa_clid?: string;
}

export interface WebhookMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  text?: { body: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    type?: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string };
  };
  referral?: WebhookReferral;
  context?: { from?: string; id?: string };
  [key: string]: unknown;
}

export interface WebhookEcho {
  id: string;
  /** Present on echoes: who the human's message went TO. */
  to?: string;
  from?: string;
  recipient_id?: string;
  timestamp?: string;
  type?: string;
  text?: { body: string };
  [key: string]: unknown;
}

export interface WebhookStatus {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string }[];
  [key: string]: unknown;
}

export interface WebhookContact {
  wa_id: string;
  profile?: { name?: string };
}

export interface WebhookValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WebhookContact[];
  messages?: WebhookMessage[];
  statuses?: WebhookStatus[];
  message_echoes?: WebhookEcho[];
  smb_message_echoes?: WebhookEcho[];
  event?: string;
  [key: string]: unknown;
}

export interface WebhookChange {
  field: string;
  value: WebhookValue;
}

export interface WebhookEntry {
  id: string;
  time?: number;
  changes?: WebhookChange[];
}

export interface WebhookPayload {
  object?: string;
  entry?: WebhookEntry[];
}

/**
 * Reads the echo array under either name.
 *
 * SPEC §4.3: coexistence echoes have shipped as both `message_echoes` and
 * `smb_message_echoes` depending on onboarding path and API version. Handle
 * both rather than betting on one.
 */
export function readEchoes(value: WebhookValue): WebhookEcho[] {
  return [...(value.message_echoes ?? []), ...(value.smb_message_echoes ?? [])];
}

/** Best-effort plain text for any inbound message type. */
export function messageText(msg: WebhookMessage): string | null {
  if (msg.text?.body) return msg.text.body;
  if (msg.button?.text) return msg.button.text;
  if (msg.interactive?.button_reply?.title) return msg.interactive.button_reply.title;
  if (msg.interactive?.list_reply?.title) return msg.interactive.list_reply.title;
  return null;
}

export const MEDIA_TYPES = new Set(['image', 'audio', 'video', 'document', 'sticker', 'voice']);

/** Meta sends unix seconds as a string. */
export function timestampToIso(ts: string | undefined): string {
  const seconds = Number.parseInt(ts ?? '', 10);
  if (!Number.isFinite(seconds)) return new Date().toISOString();
  return new Date(seconds * 1000).toISOString();
}
