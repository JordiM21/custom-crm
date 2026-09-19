import { log } from '../logger.js';
import { getStore } from '../store/index.js';
import type { Lead } from '../store/types.js';
import {
  messageText,
  readEchoes,
  timestampToIso,
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

  if (echoes.length) {
    log.info('webhook.echo_received', {
      count: echoes.length,
      field,
      human: 'Jordi replied from his phone.',
    });
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
  const lead = await resolveLead(waId, contact?.profile?.name ?? null);

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
