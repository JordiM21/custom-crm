import { config, isLiveSending } from './config.js';
import { log } from './logger.js';
import { sleep } from './async.js';

/**
 * The only module that talks to the WhatsApp Cloud API (SPEC §8).
 *
 * Every send goes through here so that dry-run, the 24-hour window check and
 * retry policy are impossible to bypass.
 */

export interface SendResult {
  ok: boolean;
  /** Meta's message id, when a real send happened. */
  waMessageId?: string;
  /** Set when the send was skipped rather than attempted. */
  skipped?: 'dry_run' | 'not_configured' | 'window_closed';
  error?: string;
}

function graphUrl(path: string): string {
  return `https://graph.facebook.com/${config.meta.graphVersion}/${path}`;
}

/** SPEC §8 — free-form messages only inside 24h of the parent's last message. */
export function isWindowOpen(lastInboundAt: string | null): boolean {
  if (!lastInboundAt) return false;
  const elapsed = Date.now() - new Date(lastInboundAt).getTime();
  return elapsed < 24 * 60 * 60 * 1000;
}

export function hoursSinceInbound(lastInboundAt: string | null): number | null {
  if (!lastInboundAt) return null;
  return (Date.now() - new Date(lastInboundAt).getTime()) / 3_600_000;
}

interface GraphError {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
  messages?: { id?: string }[];
}

/**
 * Posts to the Graph API with the retry policy from SPEC §8.
 *
 * Retries 5xx and 429 only. A 400 is never retried: a malformed message sent
 * three times is three chances to put garbage on a parent's phone.
 */
async function graphPost(path: string, body: unknown, label: string): Promise<SendResult> {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(graphUrl(path), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.meta.accessToken}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (attempt === maxAttempts) {
        return { ok: false, error: `network: ${String(err)}` };
      }
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    const payload = (await response.json().catch(() => ({}))) as GraphError;

    if (response.ok) {
      return { ok: true, waMessageId: payload.messages?.[0]?.id };
    }

    const message = payload.error?.message ?? `http ${response.status}`;
    const retryable = response.status >= 500 || response.status === 429;

    log.warn('whatsapp.send_failed', {
      label,
      status: response.status,
      code: payload.error?.code,
      message,
      attempt,
      retryable,
    });

    if (!retryable || attempt === maxAttempts) {
      return { ok: false, error: `${response.status}: ${message}` };
    }

    await sleep(500 * 2 ** (attempt - 1));
  }

  return { ok: false, error: 'exhausted retries' };
}

/**
 * Sends a free-form text message.
 *
 * In development, or with no Meta credentials, this logs what it would have
 * sent and reports success. SPEC §11: every conversation flow must be
 * exercisable without touching a real phone.
 */
export async function sendText(
  to: string,
  body: string,
  options: { lastInboundAt?: string | null; skipWindowCheck?: boolean } = {},
): Promise<SendResult> {
  if (!options.skipWindowCheck && options.lastInboundAt !== undefined) {
    if (!isWindowOpen(options.lastInboundAt ?? null)) {
      const hours = hoursSinceInbound(options.lastInboundAt ?? null);
      log.warn('whatsapp.window_closed', {
        to,
        hoursSinceInbound: hours === null ? null : Math.round(hours),
        human:
          'No se pudo responder: WhatsApp solo permite mensajes libres dentro de las 24 horas siguientes al mensaje del contacto. Este contacto necesita una plantilla aprobada o que le escribas tú.',
      });
      return { ok: false, skipped: 'window_closed', error: '24h window closed' };
    }
  }

  if (!isLiveSending()) {
    log.info('whatsapp.dry_run', {
      to,
      body,
      reason: config.environment !== 'production' ? 'development_environment' : 'missing_credentials',
      human: `Modo de pruebas: se habría enviado a ${to}: "${body}"`,
    });
    return {
      ok: true,
      skipped: config.environment !== 'production' ? 'dry_run' : 'not_configured',
    };
  }

  const result = await graphPost(
    `${config.meta.phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body },
    },
    'sendText',
  );

  if (result.ok) {
    log.info('whatsapp.sent', { to, chars: body.length, wa_message_id: result.waMessageId });
  }
  return result;
}

/**
 * Marks the parent's message as read, and optionally shows the typing bubble.
 *
 * VERIFY BEFORE PRODUCTION (SPEC §13): the typing-indicator payload has changed
 * shape more than once. If Meta rejects it, read receipts still work — the
 * indicator is cosmetic and its failure must never block a reply.
 */
export async function markAsRead(waMessageId: string, showTyping = false): Promise<SendResult> {
  if (!isLiveSending()) {
    log.debug('whatsapp.dry_run_read', { waMessageId, showTyping });
    return { ok: true, skipped: 'dry_run' };
  }

  return graphPost(
    `${config.meta.phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: waMessageId,
      ...(showTyping ? { typing_indicator: { type: 'text' } } : {}),
    },
    'markAsRead',
  );
}

export async function sendTypingIndicator(waMessageId: string): Promise<SendResult> {
  return markAsRead(waMessageId, true);
}

/**
 * Template sending. Phase 3 — the only legal way to reach a parent outside the
 * 24-hour window. Implemented so the call site exists; no template is approved
 * yet, so it refuses rather than sending something Meta will reject.
 */
export async function sendTemplate(
  to: string,
  templateName: string,
  languageCode = 'es',
  components: unknown[] = [],
): Promise<SendResult> {
  if (!templateName) return { ok: false, error: 'no template name' };

  if (!isLiveSending()) {
    log.info('whatsapp.dry_run_template', { to, templateName });
    return { ok: true, skipped: 'dry_run' };
  }

  return graphPost(
    `${config.meta.phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    },
    'sendTemplate',
  );
}

/**
 * Alerts Jordi on his personal number.
 *
 * The window check is skipped here because an alert is worth attempting even if
 * it fails. Note the real constraint: Meta applies the same 24-hour rule to
 * Jordi's own number, so if he has not written to the business number in a day,
 * these alerts will be rejected until he does, or until an approved template
 * exists. The admin panel is the reliable alert surface; this is the convenient
 * one.
 */
export async function alertOwner(text: string): Promise<SendResult> {
  if (!config.ops.ownerWhatsapp) {
    log.warn('alert.no_owner_number', {
      text,
      human: 'Se quiso enviar una alerta pero OWNER_WHATSAPP_NUMBER no está configurado.',
    });
    return { ok: false, error: 'owner number not configured' };
  }
  return sendText(config.ops.ownerWhatsapp, text, { skipWindowCheck: true });
}
