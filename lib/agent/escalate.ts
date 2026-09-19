import { config } from '../config.js';
import { log } from '../logger.js';
import { notifyOwner } from '../notify.js';
import { sendNow } from '../queue.js';
import { getStore } from '../store/index.js';
import type { Lead } from '../store/types.js';

/**
 * Hand a conversation to Jordi (SPEC §6).
 *
 * Pausing the bot is the part that must not fail. Telling Jordi is best effort
 * across every configured channel — if all of them fail, the conversation is
 * still safely paused and the lead is flagged in the admin panel.
 */

export const ESCALATION_ACK =
  'te entiendo. eso lo ve Jordi directamente contigo, le paso tu mensaje y te escribe en un ratito';

export interface EscalationResult {
  paused: boolean;
  /** Whether any notification channel reached Jordi. */
  alerted: boolean;
  /** Whether the parent was told someone will reply. */
  ackSent: boolean;
}

/** The panel link an alert points at. */
export function leadUrl(leadId: string): string | undefined {
  return config.publicUrl ? `${config.publicUrl}/?lead=${leadId}` : undefined;
}

/** Turns an internal reason code into something readable in an alert. */
function describeReason(reason: string): string {
  const map: Record<string, string> = {
    price_negotiation: 'está negociando el precio',
    refund_request: 'pide un reembolso',
    complaint: 'puso una queja',
    child_wellbeing: 'mencionó un tema de salud o aprendizaje del niño',
    unsupported_media: 'mandó una foto o un audio',
    ai_unavailable: 'falló el servicio de IA',
    cost_ceiling: 'la conversación se pasó del límite de costo',
    missing_info: 'preguntó algo que no está en la información del negocio',
    rate_limit: 'recibió demasiados mensajes seguidos',
  };
  return map[reason] ?? reason;
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

  const alert = await notifyOwner({
    kind: 'escalation',
    title: `${name} necesita que le respondas`,
    body: [
      `Motivo: ${describeReason(reason)}`,
      '',
      summary,
      '',
      `WhatsApp del contacto: https://wa.me/${lead.wa_id}`,
      lead.student_name ? `Estudiante: ${lead.student_name}` : '',
      lead.student_age !== null ? `Edad: ${lead.student_age}` : '',
    ]
      .filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== ''))
      .join('\n'),
    url: leadUrl(lead.id),
  });

  log.warn('agent.escalated', {
    lead_id: lead.id,
    reason,
    summary,
    cancelled_messages: cancelled,
    delivered: alert.delivered,
    human: `${name} necesita que le respondas tú (${describeReason(reason)}).`,
  });

  return { paused: true, alerted: !alert.silent, ackSent };
}

function appendNote(existing: string | null, addition: string): string {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = `${stamp} ${addition}`;
  return existing ? `${existing}\n${line}` : line;
}
