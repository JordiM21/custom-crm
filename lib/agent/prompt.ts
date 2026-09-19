import { config } from '../config.js';
import type { Lead } from '../store/types.js';
import { knowledgeIsComplete, loadKnowledge } from './knowledge.js';

/**
 * System prompt assembly.
 *
 * `knowledge/business.md` is the prompt. It carries the agent's identity, its
 * tone, the forbidden phrases, the order of the conversation, the business
 * facts, the objection handling and the escalation rules — and its own header
 * says it is injected verbatim. This file deliberately adds nothing that
 * overlaps with it: duplicating a rule here would mean two sources of truth
 * that drift apart, and Jordi edits the markdown, not the code.
 *
 * What is left for the code is only what a static file cannot know:
 *   - who this particular parent is and what we already learned about them
 *   - what time it is
 *   - which tools exist and how to call them
 *   - a hard guard for when the file is incomplete or unreadable
 *
 * Order follows SPEC §5.2: identity, knowledge verbatim, rules, lead context,
 * date and time, tool rules.
 */

/**
 * The only behaviour hard-coded here.
 *
 * If `business.md` is ever missing or truncated, the agent still must not
 * improvise at a parent. This is the floor, not the prompt.
 */
const SAFETY_FLOOR = `Escribes por WhatsApp, en español latinoamericano neutro, a padres y madres
que preguntan por clases de inglés para niños en LET Junior.

Regla que está por encima de todo lo demás: nunca inventes un dato del negocio.
Un precio, un horario, una política o una duración que no esté escrita más abajo
o que no venga del resultado de una herramienta, no existe. Si no lo tienes,
usa escalate_to_human.`;

const TOOL_RULES = `## Herramientas

- update_lead: úsala apenas te enteres de un dato (nombre del niño, edad, nombre del
  padre). No la dejes para el final de la conversación.
- El campo "stage" solo avanza con update_lead. Nunca asumas que avanzó solo.
- check_calendar_availability: úsala antes de proponer cualquier horario. Nunca
  inventes un horario disponible, ni siquiera uno que parezca obvio.
- book_trial_class: solo después de que el padre haya aceptado un horario concreto
  que salió de check_calendar_availability.
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

  if (lead.stage === 'new') {
    lines.push('Es el primer mensaje de esta conversación.');
  }

  return lines.join('\n');
}

function currentTime(): string {
  const formatted = new Intl.DateTimeFormat('es-CO', {
    timeZone: config.booking.timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date());
  return `Fecha y hora actual (${config.booking.timezone}): ${formatted}`;
}

export function buildSystemPrompt(lead: Lead, historySummary?: string): string {
  const knowledge = loadKnowledge();

  const sections: string[] = [SAFETY_FLOOR];

  sections.push(
    knowledge.text ||
      '## Información del negocio\n\n(El archivo de información no se pudo leer. No tienes ningún dato del negocio.)',
  );

  if (!knowledgeIsComplete()) {
    // Without this the model reads "[USD]" or "[NOMBRE DEL PLAN]" aloud to a
    // parent as though it were a real price or a real plan name.
    sections.push(
      `## ADVERTENCIA: la información de arriba está incompleta

Los textos entre corchetes ([ASÍ], [ ]) son plantillas sin rellenar, NO datos
reales. Nunca los leas, los repitas ni los interpretes como información.

Mientras queden plantillas sin rellenar:
- No des ningún precio, horario, política, duración ni nombre de plan.
- Sí puedes: saludar, preguntar la edad del niño, preguntar su nivel de inglés,
  preguntar qué busca el padre, y hablar con el tono y las reglas de arriba.
- Para cualquier pregunta concreta sobre el servicio, usa escalate_to_human con
  una frase corta y honesta, como dice la sección de escalamiento.

Esto no es un error tuyo. Es el estado actual del archivo.`,
    );
  }

  if (historySummary) {
    sections.push(`## Resumen de la conversación anterior\n\n${historySummary}`);
  }

  sections.push(`## Contexto de este contacto\n\n${leadContext(lead)}\n${currentTime()}`);
  sections.push(TOOL_RULES);

  return sections.join('\n\n---\n\n');
}

/**
 * SPEC §6 — a keyword pre-check in code, not only in the prompt.
 *
 * The knowledge file tells the model to escalate on these topics. This catches
 * the case where it does not, because these are exactly the conversations where
 * being wrong costs a customer or hurts a child.
 *
 * Kept in step with section 6 of `knowledge/business.md`. If that section
 * changes, change this too — they are meant to say the same thing, one for the
 * model and one as a backstop that does not depend on the model complying.
 */
const ESCALATION_KEYWORDS: { pattern: RegExp; reason: string }[] = [
  // "Piden descuento o quieren negociar el precio." The sibling-discount line
  // in the knowledge file is still an unfilled bracket, so there is no
  // documented answer to give and every discount question is Jordi's.
  { pattern: /\b(descuento|rebaja|promoci[oó]n|oferta especial|m[aá]s barato|me lo dejas?|precio especial|cuotas?|por clase|pagar menos|mejor precio|hacer un precio|financia)\b/i, reason: 'price_negotiation' },
  { pattern: /\b(reembolso|devoluci[oó]n|devu[eé]lv|me devuelven|cancelar el pago|contracargo)\b/i, reason: 'refund_request' },
  { pattern: /\b(queja|reclamo|estafa|fraude|denuncia|demanda|abogado)\b/i, reason: 'complaint' },
  { pattern: /\b(autis|asperger|tdah|d[ée]ficit de atenci[oó]n|dislexia|discapacidad|necesidades especiales|terapia|psic[oó]log)\b/i, reason: 'child_wellbeing' },
  { pattern: /\b(bullying|acoso|deprimid|ansiedad|problema emocional)\b/i, reason: 'child_wellbeing' },
  // "Piden hablar con Jordi o con una persona."
  // Deliberately narrow: "lo quiero hablar con mi esposo" is the objection in
  // section 5 of the knowledge file, not a request for a person.
  { pattern: /\b(hablar con (jordi|una persona|alguien|un humano|el profesor|el profe|un asesor)|p[aá]same con (jordi|una persona|alguien)|atienda una persona|no quiero hablar con un bot)\b/i, reason: 'asked_for_human' },
];

export function detectMandatoryEscalation(text: string): string | null {
  for (const { pattern, reason } of ESCALATION_KEYWORDS) {
    if (pattern.test(text)) return reason;
  }
  return null;
}
