import { log } from '../logger.js';
import { getStore } from '../store/index.js';
import type { Lead } from '../store/types.js';
import {
  messageText,
  readEchoes,
  timestampToIso,
  type WebhookEcho,
  type WebhookMessage,
  type WebhookPayload,
  type WebhookValue,
} from '../meta/types.js';

/**
 * Everything that happens AFTER the webhook has already answered 200.
 *
 * SPEC §3.3: the HTTP response is never blocked on this. Failures here must be
 * logged and contained — one bad message must not stop the rest of the batch.
 */

export interface ProcessResult {
  handled: number;
  duplicates: number;
  errors: number;
}

export async function processPayload(payload: WebhookPayload): Promise<ProcessResult> {
  const result: ProcessResult = { handled: 0, duplicates: 0, errors: 0 };

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      try {
        await processChange(change.field, change.value, result);
      } catch (err) {
        result.errors += 1;
        log.error('webhook.change_failed', {
          field: change.field,
          error: String(err),
          human: 'A WhatsApp event could not be processed.',
        });
      }
    }
  }

  return result;
}

async function processChange(
  field: string,
  value: WebhookValue,
  result: ProcessResult,
): Promise<void> {
  const echoes = readEchoes(value);

  if (value.messages?.length) {
    for (const msg of value.messages) {
      await handleInbound(msg, value, result);
    }
  }

  for (const echo of echoes) {
    await handleEcho(echo, field, result);
  }

  if (value.statuses?.length) {
    handleStatuses(value);
  }

  if (field === 'account_update' || value.event) {
    handleAccountUpdate(value);
  }

  const known =
    Boolean(value.messages?.length) ||
    echoes.length > 0 ||
    Boolean(value.statuses?.length) ||
    field === 'account_update';

  if (!known) {
    // SPEC §4.3: unknown event types must surface, not vanish.
    log.warn('webhook.unhandled_field', {
      field,
      keys: Object.keys(value),
      human: `WhatsApp sent an event type we do not handle yet (${field}).`,
    });
  }
}

/** Finds or creates the lead row for an inbound message. */
export async function resolveLead(waId: string, profileName?: string | null): Promise<Lead> {
  const store = await getStore();
  const patch: Partial<Lead> = {};
  if (profileName) patch.profile_name = profileName;
  return store.upsertLead(waId, patch);
}

/**
 * SPEC §4.2 — the Click-to-WhatsApp click id.
 *
 * `ctwa_clid` rides on the FIRST message only and never appears again. Without
 * it Meta cannot attribute a sale back to the ad that produced it, so this
 * write happens before anything else and a failure is logged loudly rather
 * than swallowed.
 *
 * Never overwrite an existing clid: a parent who clicks a second ad months
 * later must stay attributed to the click that actually started the
 * conversation.
 */
async function captureReferral(lead: Lead, msg: WebhookMessage): Promise<Lead> {
  const referral = msg.referral;
  if (!referral?.ctwa_clid) return lead;

  if (lead.ctwa_clid) {
    log.info('ctwa.already_captured', {
      lead_id: lead.id,
      existing: lead.ctwa_clid,
      incoming: referral.ctwa_clid,
    });
    return lead;
  }

  try {
    const store = await getStore();
    const updated = await store.updateLead(lead.id, {
      ctwa_clid: referral.ctwa_clid,
      ctwa_source_id: referral.source_id ?? null,
      ctwa_headline: referral.headline ?? null,
      ctwa_captured_at: new Date().toISOString(),
      tags: lead.tags.includes('ctwa') ? lead.tags : [...lead.tags, 'ctwa'],
    });
    log.info('ctwa.captured', {
      lead_id: lead.id,
      source_id: referral.source_id,
      headline: referral.headline,
      human: 'A lead arrived from a Facebook or Instagram ad and was tagged for tracking.',
    });
    return updated;
  } catch (err) {
    // Critical-path data. If this write fails the attribution is gone for good,
    // so the failure has to be visible rather than buried.
    log.error('ctwa.capture_failed', {
      lead_id: lead.id,
      wa_id: lead.wa_id,
      ctwa_clid: referral.ctwa_clid,
      source_id: referral.source_id,
      error: String(err),
      human:
        'Could not save the ad-click id for a new lead. Meta will not be able to attribute this sale.',
    });
    return lead;
  }
}

async function handleInbound(
  msg: WebhookMessage,
  value: WebhookValue,
  result: ProcessResult,
): Promise<void> {
  const store = await getStore();
  const waId = msg.from;
  if (!waId) {
    log.warn('webhook.message_without_sender', { id: msg.id });
    return;
  }

  const contact = value.contacts?.find((c) => c.wa_id === waId) ?? value.contacts?.[0];
  let lead = await resolveLead(waId, contact?.profile?.name ?? null);

  // Before the message insert: a duplicate delivery must not be the reason a
  // referral is lost, and this runs whether or not the insert dedupes.
  lead = await captureReferral(lead, msg);

  const receivedAt = timestampToIso(msg.timestamp);
  const body = messageText(msg);

  const { inserted } = await store.insertMessage({
    lead_id: lead.id,
    wa_message_id: msg.id,
    direction: 'inbound',
    body,
    raw: msg,
    created_at: receivedAt,
  });

  if (!inserted) {
    // SPEC §3.4: Meta re-delivers. This is the guard that stops a parent
    // receiving the same answer twice.
    result.duplicates += 1;
    log.info('webhook.duplicate_message', { wa_message_id: msg.id, lead_id: lead.id });
    return;
  }

  await store.updateLead(lead.id, {
    last_message_at: receivedAt,
    last_inbound_at: receivedAt,
  });

  result.handled += 1;
  log.info('webhook.inbound_message', {
    lead_id: lead.id,
    wa_id: waId,
    type: msg.type,
    chars: body?.length ?? 0,
  });
}

/**
 * SPEC §4.3 — coexistence. Jordi typed to this parent from the WhatsApp
 * Business app on his phone and Meta echoed it back to us.
 *
 * This is the whole handoff mechanism. Jordi typing is the signal; there is no
 * command for him to remember. The bot goes quiet for that parent until it is
 * resumed from the admin panel.
 */
async function handleEcho(echo: WebhookEcho, field: string, result: ProcessResult): Promise<void> {
  const store = await getStore();

  // The echo is a message Jordi SENT, so the lead is the recipient. Field name
  // varies by payload shape, so try each before giving up.
  const waId = echo.to ?? echo.recipient_id ?? null;
  if (!waId) {
    log.error('webhook.echo_without_recipient', {
      field,
      keys: Object.keys(echo),
      human: 'Jordi replied from his phone but we could not tell which parent it went to.',
    });
    result.errors += 1;
    return;
  }

  const lead = await resolveLead(waId);
  const sentAt = timestampToIso(echo.timestamp);

  const { inserted } = await store.insertMessage({
    lead_id: lead.id,
    wa_message_id: echo.id ?? null,
    direction: 'outbound_human',
    body: echo.text?.body ?? null,
    raw: echo,
    created_at: sentAt,
  });

  if (!inserted) {
    result.duplicates += 1;
    return;
  }

  // Pause first, cancel second. If the process dies between the two, a paused
  // lead with a stale queue is recoverable — the drain re-checks bot_paused
  // before every send. The reverse order would leave the bot free to talk.
  await store.updateLead(lead.id, {
    bot_paused: true,
    bot_paused_reason: 'human_replied',
    bot_paused_at: new Date().toISOString(),
    last_message_at: sentAt,
  });

  const cancelled = await store.cancelQueueForLead(lead.id, 'human_replied');

  result.handled += 1;
  log.info('webhook.human_reply', {
    lead_id: lead.id,
    wa_id: waId,
    cancelled_messages: cancelled,
    human: `Jordi replied to ${lead.display_name ?? lead.profile_name ?? waId} from his phone. The bot is now paused for this parent.`,
  });
}

function handleStatuses(value: WebhookValue): void {
  for (const status of value.statuses ?? []) {
    if (status.status === 'failed') {
      log.error('whatsapp.delivery_failed', {
        wa_message_id: status.id,
        recipient: status.recipient_id,
        errors: status.errors,
        human: 'A message could not be delivered to a parent.',
      });
    } else {
      log.debug('whatsapp.status', { wa_message_id: status.id, status: status.status });
    }
  }
}

function handleAccountUpdate(value: WebhookValue): void {
  const event = String(value.event ?? 'unknown');
  if (event === 'ACCOUNT_OFFBOARDED' || event.includes('OFFBOARD')) {
    log.error('whatsapp.account_offboarded', {
      event,
      human:
        'WhatsApp disconnected this number from the Cloud API. The bot is offline until it is reconnected.',
    });
  } else {
    log.info('whatsapp.account_update', { event });
  }
}
