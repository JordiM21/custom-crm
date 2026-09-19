import { log } from '../logger.js';
import { getStore } from '../store/index.js';
import type { Lead } from '../store/types.js';
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
  /** The line to send the parent, or null when the caller sends its own. */
  ack: string | null;
}

export async function escalateToHuman(
  lead: Lead,
  reason: string,
  summary: string,
  options: { ack?: boolean } = {},
): Promise<EscalationResult> {
  const store = await getStore();

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
    human: `${name} needs a personal reply from Jordi (${reason}).`,
  });

  return {
    paused: true,
    alerted: alert.ok,
    ack: options.ack === false ? null : ESCALATION_ACK,
  };
}

function appendNote(existing: string | null, addition: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = `${stamp} ${addition}`;
  return existing ? `${existing}\n${line}` : line;
}
