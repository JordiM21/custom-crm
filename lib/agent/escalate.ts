import { log } from '../logger.js';
import { getStore } from '../store/index.js';
import type { Lead } from '../store/types.js';
import { sendNow } from '../queue.js';
import { alertOwner } from '../whatsapp.js';

/**
 * Hand a conversation to Jordi (SPEC §6).
 *
 * Pausing the bot is the part that must not fail. Alerting Jordi is best
 * effort — if WhatsApp rejects the alert, the conversation is still safely
 * paused and the lead shows up in the admin panel flagged for attention.
 */

export const ESCALATION_ACK =
  'te entiendo. eso lo ve Jordi directamente contigo, le paso tu mensaje y te escribe en un ratito';

export interface EscalationResult {
  paused: boolean;
  alerted: boolean;
  /** Whether the parent was told someone will reply. */
  ackSent: boolean;
}

export async function escalateToHuman(
  lead: Lead,
  reason: string,
  summary: string,
  options: { ack?: boolean } = {},
): Promise<EscalationResult> {
  const store = await getStore();

  // Before the pause: once bot_paused is set, the queue drain cancels
  // everything for this lead, which would include this acknowledgement.
  const ackSent = options.ack === false ? false : await sendNow(lead, ESCALATION_ACK);

  await store.updateLead(lead.id, {
    bot_paused: true,
    bot_paused_reason: `escalated:${reason}`,
    bot_paused_at: new Date().toISOString(),
    stage: lead.stage === 'enrolled' ? lead.stage : 'human_handling',
    notes: appendNote(lead.notes, `[escalado: ${reason}] ${summary}`),
  });

  const cancelled = await store.cancelQueueForLead(lead.id, `escalated:${reason}`);

  const name = lead.display_name ?? lead.profile_name ?? lead.wa_id;
  const alert = await alertOwner(
    [
      `Un lead necesita que le respondas tú.`,
      ``,
      `${name} — wa.me/${lead.wa_id}`,
      `Motivo: ${reason}`,
      ``,
      summary,
    ].join('\n'),
  );

  log.warn('agent.escalated', {
    lead_id: lead.id,
    reason,
    summary,
    cancelled_messages: cancelled,
    alerted: alert.ok,
    human: `${name} necesita que le respondas tú (${reason}).`,
  });

  return { paused: true, alerted: alert.ok, ackSent };
}

function appendNote(existing: string | null, addition: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = `${stamp} ${addition}`;
  return existing ? `${existing}\n${line}` : line;
}
