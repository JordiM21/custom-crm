import type { ToolDefinition } from '../ai/types.js';
import { config } from '../config.js';
import {
  calendarIsConfigured,
  createEvent,
  findAvailableSlots,
  slotIsStillFree,
} from '../integrations/google-calendar.js';
import { createPaymentLink, stripeIsConfigured } from '../integrations/stripe.js';
import { log } from '../logger.js';
import { findPlan, planIds } from '../plans.js';
import { getStore } from '../store/index.js';
import { isStage, type Lead, type Stage } from '../store/types.js';
import { formatSlotForParent } from '../timezone.js';
import { alertOwner } from '../whatsapp.js';
import { escalateToHuman } from './escalate.js';

/**
 * The six tools from SPEC §6. Every one has real side effects.
 *
 * Errors are returned to the model as text rather than thrown: a tool that
 * cannot do its job should make the model escalate, not crash the turn.
 */

export interface ToolOutcome {
  result: unknown;
  isError?: boolean;
  /** Set when the tool ended the bot's turn, e.g. an escalation. */
  stopConversation?: boolean;
  /** What to say to the parent instead of the model's own text. */
  replyOverride?: string;
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'check_calendar_availability',
      description:
        'Consulta los horarios libres para una clase de prueba. Úsala SIEMPRE antes de proponer un horario. Nunca inventes disponibilidad.',
      parameters: {
        type: 'object',
        properties: {
          date_range_start: {
            type: 'string',
            description: 'Inicio del rango a consultar, en formato ISO 8601 (ej. 2026-09-22T00:00:00Z).',
          },
          date_range_end: {
            type: 'string',
            description: 'Fin del rango a consultar, en formato ISO 8601.',
          },
          preferred_time_of_day: {
            type: 'string',
            enum: ['morning', 'afternoon', 'evening'],
            description: 'Franja preferida por el padre, si la mencionó.',
          },
        },
        required: ['date_range_start', 'date_range_end'],
      },
    },
    {
      name: 'book_trial_class',
      description:
        'Agenda la clase de prueba. Úsala solo cuando el padre ya aceptó un horario concreto que salió de check_calendar_availability.',
      parameters: {
        type: 'object',
        properties: {
          slot_start_iso: { type: 'string', description: 'Inicio del horario elegido, ISO 8601.' },
          student_name: { type: 'string', description: 'Nombre del niño o niña.' },
          student_age: { type: 'number', description: 'Edad del estudiante.' },
          parent_name: { type: 'string', description: 'Nombre del padre o madre.' },
        },
        required: ['slot_start_iso', 'student_name', 'student_age', 'parent_name'],
      },
    },
    {
      name: 'create_payment_link',
      description:
        'Genera el link de pago de un plan existente. Nunca construyas un precio tú mismo.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: {
            type: 'string',
            enum: planIds(),
            description: 'Identificador del plan, de la configuración.',
          },
        },
        required: ['plan_id'],
      },
    },
    {
      name: 'escalate_to_human',
      description:
        'Pasa la conversación a Jordi. Úsala ante cualquier duda, queja, negociación de precio, tema de salud o bienestar del niño, o cualquier pregunta que no puedas responder con la información que tienes.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Motivo corto, en snake_case (ej. price_negotiation, missing_info).',
          },
          summary: {
            type: 'string',
            description: 'Resumen en español de lo que necesita el padre, para que Jordi retome sin leer todo.',
          },
        },
        required: ['reason', 'summary'],
      },
    },
    {
      name: 'update_lead',
      description:
        'Guarda lo que vas aprendiendo del contacto. Llámala apenas te enteres de un dato, no al final de la conversación. Es la única forma de avanzar la etapa.',
      parameters: {
        type: 'object',
        properties: {
          display_name: { type: 'string', description: 'Nombre que dio el padre o madre.' },
          student_name: { type: 'string', description: 'Nombre del estudiante.' },
          student_age: { type: 'number', description: 'Edad del estudiante.' },
          stage: {
            type: 'string',
            enum: ['engaged', 'qualified', 'trial_completed', 'enrolled', 'lost', 'unqualified'],
            description: 'Nueva etapa del contacto.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Etiquetas a añadir.',
          },
          notes: { type: 'string', description: 'Nota interna corta.' },
        },
      },
    },
    {
      name: 'record_conversion_event',
      description:
        'Registra un evento de conversión para el seguimiento de anuncios. Marca "Lead" cuando el padre ya dio la edad del niño y mostró interés real, no en el primer saludo.',
      parameters: {
        type: 'object',
        properties: {
          event_name: { type: 'string', enum: ['Lead', 'Purchase'] },
          value: { type: 'number', description: 'Valor en USD, solo para Purchase.' },
        },
        required: ['event_name'],
      },
    },
  ];
}

export async function executeTool(
  lead: Lead,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  log.info('tool.called', { lead_id: lead.id, tool: name, input });

  try {
    const outcome = await dispatch(lead, name, input);
    log.info('tool.result', {
      lead_id: lead.id,
      tool: name,
      isError: Boolean(outcome.isError),
      result: outcome.result,
    });
    return outcome;
  } catch (err) {
    log.error('tool.failed', { lead_id: lead.id, tool: name, error: String(err) });
    return {
      result: `La herramienta ${name} falló: ${String(err)}. Usa escalate_to_human.`,
      isError: true,
    };
  }
}

async function dispatch(
  lead: Lead,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  switch (name) {
    case 'check_calendar_availability':
      return checkAvailability(input);
    case 'book_trial_class':
      return bookTrial(lead, input);
    case 'create_payment_link':
      return paymentLink(lead, input);
    case 'escalate_to_human':
      return escalate(lead, input);
    case 'update_lead':
      return updateLead(lead, input);
    case 'record_conversion_event':
      return recordConversion(lead, input);
    default:
      return { result: `Herramienta desconocida: ${name}`, isError: true };
  }
}

// -----------------------------------------------------------------------------

async function checkAvailability(input: Record<string, unknown>): Promise<ToolOutcome> {
  if (!calendarIsConfigured()) {
    return {
      result:
        'El calendario no está conectado, así que no puedes consultar ni proponer horarios. Usa escalate_to_human para que Jordi coordine el horario.',
      isError: true,
    };
  }

  const start = String(input['date_range_start'] ?? '');
  const end = String(input['date_range_end'] ?? '');
  const preferred = input['preferred_time_of_day'] as 'morning' | 'afternoon' | 'evening' | undefined;

  const slots = await findAvailableSlots(start, end, preferred);

  if (slots.length === 0) {
    return {
      result:
        'No hay horarios libres en ese rango. Pregúntale al padre por otro rango de fechas, o usa escalate_to_human si ya intentaste varias veces.',
    };
  }

  return {
    result: {
      slots: slots.map((s) => ({ start: s.startIso, cuando: s.label })),
      nota: 'Ofrece máximo dos opciones al padre, en una sola pregunta.',
    },
  };
}

async function bookTrial(lead: Lead, input: Record<string, unknown>): Promise<ToolOutcome> {
  if (!calendarIsConfigured()) {
    return {
      result: 'El calendario no está conectado. Usa escalate_to_human.',
      isError: true,
    };
  }

  const slotStart = String(input['slot_start_iso'] ?? '');
  const studentName = String(input['student_name'] ?? '').trim();
  const parentName = String(input['parent_name'] ?? '').trim();
  const studentAge = Number(input['student_age']);

  if (!slotStart || Number.isNaN(new Date(slotStart).getTime())) {
    return { result: 'slot_start_iso no es una fecha válida.', isError: true };
  }
  if (!studentName) {
    return { result: 'Falta student_name. Pregúntale el nombre del niño antes de agendar.', isError: true };
  }

  // SPEC §6: re-check before writing. Two parents can accept the same slot
  // seconds apart.
  if (!(await slotIsStillFree(slotStart))) {
    return {
      result:
        'Ese horario se acaba de ocupar. Vuelve a llamar check_calendar_availability y ofrécele otra opción.',
      isError: true,
    };
  }

  const event = await createEvent(
    slotStart,
    `Clase de prueba — ${studentName}`,
    [
      `Estudiante: ${studentName}${Number.isFinite(studentAge) ? ` (${studentAge} años)` : ''}`,
      `Padre/madre: ${parentName || '—'}`,
      `WhatsApp: https://wa.me/${lead.wa_id}`,
    ].join('\n'),
  );

  const store = await getStore();
  await store.updateLead(lead.id, {
    stage: 'trial_booked',
    student_name: studentName || lead.student_name,
    student_age: Number.isFinite(studentAge) ? studentAge : lead.student_age,
    display_name: parentName || lead.display_name,
  });

  await store.insertConversionEvent({
    lead_id: lead.id,
    event_name: 'Schedule',
    value: null,
    currency: 'USD',
    ctwa_clid: lead.ctwa_clid,
  });

  const label = formatSlotForParent(new Date(slotStart), config.booking.timezone);

  await alertOwner(
    [
      `Clase de prueba agendada.`,
      ``,
      `${studentName}${Number.isFinite(studentAge) ? `, ${studentAge} años` : ''}`,
      `Cuándo: ${label}`,
      `Padre/madre: ${parentName || lead.profile_name || '—'}`,
      `WhatsApp: wa.me/${lead.wa_id}`,
    ].join('\n'),
  );

  return {
    result: {
      ok: true,
      cuando: label,
      evento: event.id,
      nota: 'Confírmale al padre el día y la hora en un mensaje corto.',
    },
  };
}

async function paymentLink(lead: Lead, input: Record<string, unknown>): Promise<ToolOutcome> {
  const planId = String(input['plan_id'] ?? '');
  const plan = findPlan(planId);

  if (!plan) {
    // The model invented a plan. Do not improvise a price for it.
    return {
      result: `No existe el plan "${planId}". Los planes disponibles son: ${planIds().join(', ') || '(ninguno configurado)'}. Si el padre pide algo distinto, usa escalate_to_human.`,
      isError: true,
    };
  }

  if (!stripeIsConfigured() || !plan.stripePriceId) {
    return {
      result:
        'Los pagos todavía no están conectados, así que no puedes mandar un link. Usa escalate_to_human para que Jordi le pase el link personalmente.',
      isError: true,
    };
  }

  const link = await createPaymentLink(plan, lead.wa_id);

  return {
    result: {
      url: link.url,
      plan: plan.label,
      nota: 'Mándale el link en un mensaje corto, sin repetir el precio si ya lo hablaron.',
    },
  };
}

async function escalate(lead: Lead, input: Record<string, unknown>): Promise<ToolOutcome> {
  const reason = String(input['reason'] ?? 'unspecified');
  const summary = String(input['summary'] ?? 'Sin resumen.');

  await escalateToHuman(lead, reason, summary);

  return {
    result: { ok: true, nota: 'La conversación quedó en manos de Jordi.' },
    stopConversation: true,
  };
}

async function updateLead(lead: Lead, input: Record<string, unknown>): Promise<ToolOutcome> {
  const patch: Partial<Lead> = {};
  const changed: string[] = [];

  const displayName = input['display_name'];
  if (typeof displayName === 'string' && displayName.trim()) {
    patch.display_name = displayName.trim();
    changed.push('display_name');
  }

  const studentName = input['student_name'];
  if (typeof studentName === 'string' && studentName.trim()) {
    patch.student_name = studentName.trim();
    changed.push('student_name');
  }

  const studentAge = Number(input['student_age']);
  if (Number.isFinite(studentAge) && studentAge > 0 && studentAge < 100) {
    patch.student_age = Math.round(studentAge);
    changed.push('student_age');
  }

  const stage = input['stage'];
  if (typeof stage === 'string') {
    if (!isStage(stage)) {
      return { result: `Etapa desconocida: "${stage}".`, isError: true };
    }
    // trial_booked and human_handling are set by the tools that cause them, so
    // the stage cannot drift away from what actually happened.
    if (stage === 'trial_booked' || stage === 'human_handling') {
      return {
        result: `La etapa "${stage}" la fija el sistema, no update_lead.`,
        isError: true,
      };
    }
    patch.stage = stage as Stage;
    changed.push('stage');
  }

  const tags = input['tags'];
  if (Array.isArray(tags)) {
    const incoming = tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
    const merged = [...new Set([...lead.tags, ...incoming.map((t) => t.trim())])];
    patch.tags = merged;
    changed.push('tags');
  }

  const notes = input['notes'];
  if (typeof notes === 'string' && notes.trim()) {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    patch.notes = lead.notes ? `${lead.notes}\n${stamp} ${notes.trim()}` : `${stamp} ${notes.trim()}`;
    changed.push('notes');
  }

  if (changed.length === 0) {
    return { result: 'No había nada que guardar.', isError: true };
  }

  const store = await getStore();
  await store.updateLead(lead.id, patch);

  return { result: { ok: true, guardado: changed } };
}

async function recordConversion(lead: Lead, input: Record<string, unknown>): Promise<ToolOutcome> {
  const eventName = String(input['event_name'] ?? '');

  if (eventName !== 'Lead' && eventName !== 'Purchase') {
    // Schedule is fired by book_trial_class, never by the model (SPEC §6).
    return {
      result: `event_name debe ser "Lead" o "Purchase". "Schedule" lo registra el sistema al agendar.`,
      isError: true,
    };
  }

  const store = await getStore();
  const existing = await store.listConversionEvents(lead.id);
  if (existing.some((e) => e.event_name === eventName)) {
    return { result: `El evento ${eventName} ya estaba registrado para este contacto.` };
  }

  const rawValue = Number(input['value']);
  const value = eventName === 'Purchase' ? (Number.isFinite(rawValue) ? rawValue : 50) : null;

  await store.insertConversionEvent({
    lead_id: lead.id,
    event_name: eventName,
    value,
    currency: 'USD',
    ctwa_clid: lead.ctwa_clid,
  });

  if (!lead.ctwa_clid) {
    // SPEC §7: an event with no click id cannot be attributed and is never sent
    // to Meta. Recording it locally still tells Jordi what happened.
    log.info('conversion.unattributed', {
      lead_id: lead.id,
      event_name: eventName,
      human: 'Conversión registrada, pero este contacto no vino de un anuncio, así que Meta no puede atribuirla.',
    });
  }

  return { result: { ok: true, evento: eventName } };
}
