import { randomUUID } from 'node:crypto';
import { sleep } from './async.js';
import { getBotState } from './killswitch.js';
import { log } from './logger.js';
import { getStore } from './store/index.js';
import type { Lead, QueueItem } from './store/types.js';
import { isSimulated } from './simulator.js';
import { isWindowOpen, sendText } from './whatsapp.js';

/**
 * Drains `outbound_queue` (SPEC §5.4).
 *
 * Every row is re-validated at send time, never at enqueue time. Between the
 * model writing a reply and that reply going out there are 8–45 seconds in
 * which Jordi may have answered from his phone, the parent's 24-hour window may
 * have closed, or the kill switch may have been flipped.
 */

export interface DrainResult {
  sent: number;
  cancelled: number;
  failed: number;
  skipped: number;
}

/** Bot messages allowed to one lead per 24h before we stop and alert (SPEC §9). */
export const PER_LEAD_DAILY_CAP = 10;

export interface DrainOptions {
  /**
   * Send everything pending regardless of its send time.
   *
   * Only the panel's practice mode passes this: the 8-45 second human delay is
   * right for a real parent and pointless when someone is sitting in front of
   * the screen judging the wording.
   */
  ignorePacing?: boolean;
}

export async function drainQueue(limit = 25, options: DrainOptions = {}): Promise<DrainResult> {
  const result: DrainResult = { sent: 0, cancelled: 0, failed: 0, skipped: 0 };
  const store = await getStore();

  const botState = await getBotState();
  if (!botState.enabled) {
    const pending = await store.pendingQueueCount();
    if (pending > 0) {
      log.warn('queue.paused_by_kill_switch', {
        pending,
        blockedBy: botState.blockedBy,
        human: `El bot está apagado. Hay ${pending} mensaje(s) esperando que no se van a enviar.`,
      });
    }
    result.skipped = pending;
    return result;
  }

  const asOf = options.ignorePacing
    ? new Date(Date.now() + 86_400_000).toISOString()
    : new Date().toISOString();
  const due = await store.dueQueueItems(asOf, limit);

  for (const item of due) {
    try {
      await sendQueued(item, result);
    } catch (err) {
      result.failed += 1;
      await store.markQueueFailed(item.id, String(err));
      log.error('queue.send_threw', { queue_id: item.id, error: String(err) });
    }
  }

  if (result.sent || result.cancelled || result.failed) {
    log.info('queue.drained', { ...result });
  }
  return result;
}

async function sendQueued(item: QueueItem, result: DrainResult): Promise<void> {
  const store = await getStore();
  const lead = await store.getLeadById(item.lead_id);

  if (!lead) {
    await store.markQueueFailed(item.id, 'lead not found');
    result.failed += 1;
    return;
  }

  // SPEC §5.4: if Jordi jumped in during the delay, drop the queued message.
  if (lead.bot_paused) {
    await store.cancelQueueForLead(lead.id, `bot_paused:${lead.bot_paused_reason ?? 'unknown'}`);
    result.cancelled += 1;
    log.info('queue.cancelled_paused', { lead_id: lead.id, queue_id: item.id });
    return;
  }

  if (!isSimulated(lead) && !isWindowOpen(lead.last_inbound_at)) {
    await store.cancelQueueForLead(lead.id, 'window_closed');
    result.cancelled += 1;
    log.warn('queue.cancelled_window_closed', {
      lead_id: lead.id,
      human: `No se pudo responder a ${leadName(lead.display_name, lead.profile_name, lead.wa_id)}: pasaron más de 24 horas desde su último mensaje.`,
    });
    return;
  }

  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const sentToday = await store.countMessagesSince(lead.id, 'outbound_bot', since);
  if (sentToday >= PER_LEAD_DAILY_CAP) {
    // Backstop against a loop that would talk to a real parent forever.
    await store.updateLead(lead.id, {
      bot_paused: true,
      bot_paused_reason: 'rate_limit',
      bot_paused_at: new Date().toISOString(),
    });
    await store.cancelQueueForLead(lead.id, 'rate_limit');
    result.cancelled += 1;
    log.error('queue.rate_limit_hit', {
      lead_id: lead.id,
      sentToday,
      human: `El bot le envió ${sentToday} mensajes a ${leadName(lead.display_name, lead.profile_name, lead.wa_id)} en 24 horas. Quedó en pausa para este contacto: revisa la conversación.`,
    });
    return;
  }

  const send = isSimulated(lead)
    ? { ok: true as const, skipped: 'dry_run' as const }
    : await sendText(lead.wa_id, item.body, { lastInboundAt: lead.last_inbound_at });

  if (!send.ok) {
    await store.markQueueFailed(item.id, send.error ?? 'unknown');
    result.failed += 1;
    return;
  }

  await store.markQueueSent(item.id);
  await store.insertMessage({
    lead_id: lead.id,
    wa_message_id: 'waMessageId' in send && send.waMessageId ? send.waMessageId : `local.${item.id}`,
    direction: 'outbound_bot',
    body: item.body,
    raw: { queue_id: item.id, dry_run: Boolean(send.skipped) },
  });
  await store.updateLead(lead.id, { last_message_at: new Date().toISOString() });

  result.sent += 1;
}

function leadName(display: string | null, profile: string | null, waId: string): string {
  return display ?? profile ?? waId;
}

/**
 * Sends one message right now, bypassing the queue.
 *
 * The queue is the right path for everything the agent says, because the drain
 * re-checks `bot_paused` before each send. That check is exactly wrong for the
 * two messages that accompany a handoff — the escalation acknowledgement and
 * the reply to an unsupported photo or voice note. Both are queued at the same
 * moment the lead is paused, so the drain would cancel them and the parent
 * would get silence at the worst possible moment: right after asking about a
 * discount, or right after sending a photo.
 *
 * Pacing does not apply either. These lines are an acknowledgement, and an
 * acknowledgement that arrives 40 seconds later is not an acknowledgement.
 */
export async function sendNow(lead: Lead, body: string): Promise<boolean> {
  const store = await getStore();

  const botState = await getBotState();
  if (!botState.enabled) {
    log.warn('outbound.suppressed_kill_switch', {
      lead_id: lead.id,
      human: 'El bot está apagado, así que no se envió el aviso al contacto.',
    });
    return false;
  }

  const send = isSimulated(lead)
    ? { ok: true as const, skipped: 'dry_run' as const, waMessageId: undefined }
    : await sendText(lead.wa_id, body, { lastInboundAt: lead.last_inbound_at });

  if (!send.ok) {
    log.warn('outbound.immediate_failed', { lead_id: lead.id, error: send.error });
    return false;
  }

  await store.insertMessage({
    lead_id: lead.id,
    wa_message_id: send.waMessageId ?? `local.now.${randomUUID()}`,
    direction: 'outbound_bot',
    body,
    raw: { immediate: true, dry_run: Boolean(send.skipped) },
  });
  await store.updateLead(lead.id, { last_message_at: new Date().toISOString() });

  return true;
}

/**
 * Waits out the pacing delay inside the current invocation and sends.
 *
 * Why this exists: the cron route is the correct drain, but Vercel's Hobby
 * plan only runs cron jobs once a day, which would leave every reply stuck for
 * hours. Keeping the invocation alive through the 8–45 second delay makes the
 * bot work on the free tier; the cron remains the safety net that catches
 * anything this misses. Bounded by `deadlineMs` so it always finishes inside
 * the function's time limit.
 */
export async function drainAfterDelay(deadlineMs = 50_000): Promise<DrainResult> {
  const total: DrainResult = { sent: 0, cancelled: 0, failed: 0, skipped: 0 };
  const store = await getStore();
  const until = Date.now() + deadlineMs;

  while (Date.now() < until) {
    const round = await drainQueue();
    total.sent += round.sent;
    total.cancelled += round.cancelled;
    total.failed += round.failed;
    total.skipped += round.skipped;

    const nextDue = await store.nextPendingSendAfter();
    if (!nextDue) break;

    // Sleep exactly until the next message is due rather than polling.
    const waitFor = Math.min(
      Math.max(new Date(nextDue).getTime() - Date.now(), 250),
      until - Date.now(),
    );
    if (waitFor <= 0) break;
    await sleep(waitFor);
  }

  return total;
}
