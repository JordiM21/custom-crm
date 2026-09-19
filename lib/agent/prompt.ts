import { config } from '../config.js';
import type { Lead } from '../store/types.js';
import { knowledgeIsComplete, loadKnowledge } from './knowledge.js';

/**
 * System prompt assembly, in the order SPEC §5.2 specifies:
 * identity, knowledge verbatim, conversation rules, lead context, date/time,
 * tool rules.
 */

const IDENTITY = `Eres parte del equipo de LET Junior, una escuela de inglés en línea para niños de América Latina.
Escribes por WhatsApp con el padre o la madre de un posible estudiante.
Escribes en español latinoamericano neutro.`;

const CONVERSATION_RULES = `## Cómo escribes

- Escribes como una persona que manda un mensaje de WhatsApp, no como una empresa.
- Mensajes cortos. Si tu respuesta pasa de 300 caracteres, es demasiado larga.
- UNA sola pregunta por mensaje. Nunca dos preguntas juntas.
- Minúsculas donde sea natural. Nada de saludos formales tipo "¡Hola! 👋 Gracias por contactarnos".
- Nada de listas con viñetas, nada de muros de emojis, nada de texto de folleto.
- Español latinoamericano neutro. Nunca uses "vale", "vosotros" ni vocabulario de España.
- Nunca digas que eres humano. Si te preguntan directamente si eres un bot, dilo con
  naturalidad: eres un asistente, y Jordi lee todo personalmente.
- No vendas antes de entender. Pregunta la edad del niño y su nivel actual de inglés
  ANTES de mencionar planes o precios.
- Nunca repitas una pregunta que el padre ya respondió. Tienes toda la conversación arriba.
- Si el padre escribe en portugués o inglés, respóndele en ese idioma.

## Regla más importante

NUNCA digas un precio, un horario, una disponibilidad ni ninguna otra información
del negocio que no esté escrita arriba en la sección de información, o que no venga
del resultado de una herramienta.

Si no tienes el dato, no lo inventes ni lo aproximes: usa la herramienta
escalate_to_human.`;

const ESCALATION_RULES = `## Cuándo pasar la conversación a Jordi (obligatorio)

Usa escalate_to_human de inmediato si ocurre cualquiera de estas cosas:

- El padre pide un descuento, negocia el precio o pregunta por promociones.
- Hay una queja, un reclamo o una solicitud de reembolso.
- Se menciona una dificultad de aprendizaje, una discapacidad, un tema de salud
  o el bienestar emocional del niño.
- Te preguntan algo que no está en la información de arriba.
- El padre suena molesto, preocupado o decepcionado.

En estos casos no intentes resolver. Escala y dile al padre que Jordi le escribe
personalmente en un momento.`;

const TOOL_RULES = `## Herramientas

- update_lead: úsala apenas te enteres de un dato (nombre del niño, edad, nombre del
  padre). No la dejes para el final de la conversación.
- El campo "stage" solo avanza con update_lead. Nunca asumas que avanzó solo.
- check_calendar_availability: úsala antes de proponer cualquier horario. Nunca
  inventes un horario disponible.
- book_trial_class: solo después de que el padre haya aceptado un horario concreto.
- create_payment_link: solo con un plan que exista en la configuración. Nunca
  construyas un precio tú.
- record_conversion_event: marca "Lead" cuando el padre ya dio la edad del niño y
  mostró interés real. No en el primer "hola".
- escalate_to_human: ante cualquier duda, esta.`;

function leadContext(lead: Lead): string {
  const lines: string[] = [];
  lines.push(`Número de WhatsApp: ${lead.wa_id}`);
  lines.push(`Etapa actual: ${lead.stage}`);

  const parent = lead.display_name ?? lead.profile_name;
  lines.push(parent ? `Nombre del padre/madre: ${parent}` : 'Nombre del padre/madre: aún no lo sabes');

  lines.push(
    lead.student_name ? `Nombre del estudiante: ${lead.student_name}` : 'Nombre del estudiante: aún no lo sabes',
  );
  lines.push(
    lead.student_age !== null ? `Edad del estudiante: ${lead.student_age}` : 'Edad del estudiante: aún no la sabes',
  );

  if (lead.tags.length) lines.push(`Etiquetas: ${lead.tags.join(', ')}`);
  if (lead.notes) lines.push(`Notas internas: ${lead.notes}`);

  if (lead.ctwa_headline) {
    lines.push(
      `Este padre llegó haciendo clic en este anuncio: "${lead.ctwa_headline}". ` +
        `Escribe como si supieras a qué oferta respondió, sin repetirla textualmente.`,
    );
  }

  const isFirstTurn = lead.stage === 'new';
  if (isFirstTurn) {
    lines.push('Es el primer mensaje de esta conversación.');
  }

  return lines.join('\n');
}

function currentTime(): string {
  const now = new Date();
  const formatted = new Intl.DateTimeFormat('es-CO', {
    timeZone: config.booking.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(now);
  return `Fecha y hora actual (${config.booking.timezone}): ${formatted}`;
}

export function buildSystemPrompt(lead: Lead, historySummary?: string): string {
  const knowledge = loadKnowledge();

  const sections: string[] = [IDENTITY];

  sections.push(`## Información del negocio\n\n${knowledge.text || '(sin información disponible)'}`);

  if (!knowledgeIsComplete()) {
    // Without this guard the model would happily read "«USD ___ al mes»" aloud
    // to a parent as though it were a price.
    sections.push(
      `## ADVERTENCIA IMPORTANTE

La información del negocio de arriba está INCOMPLETA: contiene plantillas sin
rellenar (texto entre «comillas angulares»). Ese texto NO son datos reales.

Mientras esto sea así:
- No des ningún precio, horario, política ni duración de clase.
- Puedes saludar, preguntar la edad del niño y su nivel de inglés.
- Para cualquier pregunta concreta sobre el servicio, usa escalate_to_human.`,
    );
  }

  sections.push(CONVERSATION_RULES);
  sections.push(ESCALATION_RULES);

  if (historySummary) {
    sections.push(`## Resumen de la conversación anterior\n\n${historySummary}`);
  }

  sections.push(`## Contexto de este contacto\n\n${leadContext(lead)}\n${currentTime()}`);
  sections.push(TOOL_RULES);

  return sections.join('\n\n');
}

/**
 * SPEC §6 — a keyword pre-check in code, not only in the prompt.
 *
 * The prompt tells the model to escalate on these topics. This catches the case
 * where it does not, because these are exactly the conversations where being
 * wrong costs a customer or hurts a child.
 */
const ESCALATION_KEYWORDS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(descuento|rebaja|promoci[oó]n|oferta especial|m[aá]s barato|me lo dejas|precio especial)\b/i, reason: 'price_negotiation' },
  { pattern: /\b(reembolso|devoluci[oó]n|devu[eé]lv|me devuelven|cancelar el pago|contracargo)\b/i, reason: 'refund_request' },
  { pattern: /\b(queja|reclamo|estafa|fraude|denuncia|demanda|abogado)\b/i, reason: 'complaint' },
  { pattern: /\b(autis|asperger|tdah|d[ée]ficit de atenci[oó]n|dislexia|discapacidad|necesidades especiales|terapia|psic[oó]log)\b/i, reason: 'child_wellbeing' },
  { pattern: /\b(bullying|acoso|deprimid|ansiedad|problema emocional)\b/i, reason: 'child_wellbeing' },
];

export function detectMandatoryEscalation(text: string): string | null {
  for (const { pattern, reason } of ESCALATION_KEYWORDS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}
