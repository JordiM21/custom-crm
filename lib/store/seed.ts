import type { Lead, Store } from './types.js';

/**
 * Demo data for the admin panel.
 *
 * Loaded only into the in-memory store, never into Supabase. Every phone number
 * here is a documentation-range placeholder and every name is invented. The
 * panel labels this data as fake wherever it is shown.
 */

interface SeedMessage {
  direction: 'inbound' | 'outbound_bot' | 'outbound_human';
  body: string;
  /** Minutes before "now". */
  minutesAgo: number;
}

interface SeedLead {
  lead: Partial<Lead> & { wa_id: string };
  messages: SeedMessage[];
}

const minutes = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const SEED: SeedLead[] = [
  {
    lead: {
      wa_id: '573001112233',
      profile_name: 'Marcela R.',
      display_name: 'Marcela',
      student_name: 'Sofía',
      student_age: 9,
      stage: 'trial_booked',
      tags: ['ctwa', 'colombia'],
      ctwa_clid: 'DEMO_CLID_8f21a9',
      ctwa_source_id: '120209876543210',
      ctwa_headline: 'Clases de inglés para niños — primera clase gratis',
      ctwa_captured_at: minutes(2880),
      first_contact_at: minutes(2880),
      cost_usd: 0.042,
      notes: 'Quiere que Sofía gane confianza para hablar, no solo gramática.',
    },
    messages: [
      { direction: 'inbound', body: 'hola, vi el anuncio de las clases de inglés', minutesAgo: 2880 },
      { direction: 'outbound_bot', body: 'hola! qué bueno que escribiste. cuántos años tiene tu hijo o hija?', minutesAgo: 2878 },
      { direction: 'inbound', body: 'tiene 9, se llama Sofía', minutesAgo: 2870 },
      { direction: 'outbound_bot', body: 'perfecto, 9 es muy buena edad para empezar. cómo va Sofía con el inglés ahorita, ya lleva algo en el colegio?', minutesAgo: 2868 },
      { direction: 'inbound', body: 'si pero le da pena hablar, entiende algo pero no se suelta', minutesAgo: 2850 },
      { direction: 'outbound_bot', body: 'eso es lo más común, y justo es lo que trabajamos primero. te agendo una clase de prueba para que la veas en acción?', minutesAgo: 2848 },
      { direction: 'inbound', body: 'dale, el jueves en la tarde me sirve', minutesAgo: 2820 },
      { direction: 'outbound_bot', body: 'listo, te agendé el jueves a las 4:00 pm. te llega el recordatorio por acá', minutesAgo: 2818 },
    ],
  },
  {
    lead: {
      wa_id: '521559988776',
      profile_name: 'Luis Fernando',
      display_name: 'Luis',
      student_name: 'Mateo',
      student_age: 12,
      stage: 'enrolled',
      tags: ['ctwa', 'mexico', 'plan-completo'],
      ctwa_clid: 'DEMO_CLID_2b77c4',
      ctwa_source_id: '120209876543211',
      ctwa_headline: 'Inglés para niños de 7 a 14 — profesor en vivo',
      ctwa_captured_at: minutes(20160),
      first_contact_at: minutes(20160),
      cost_usd: 0.118,
      notes: 'Paga plan completo. Mateo entra los martes y jueves.',
    },
    messages: [
      { direction: 'inbound', body: 'buenas, información de las clases por favor', minutesAgo: 20160 },
      { direction: 'outbound_bot', body: 'claro. cuántos años tiene el estudiante?', minutesAgo: 20158 },
      { direction: 'inbound', body: '12 años', minutesAgo: 20140 },
      { direction: 'outbound_bot', body: 'y cómo se siente con el inglés, le cuesta o ya tiene base?', minutesAgo: 20138 },
      { direction: 'inbound', body: 'tiene base pero necesita practicar conversación', minutesAgo: 20100 },
      { direction: 'outbound_human', body: 'Hola Luis, soy Jordi. Te paso el link de pago del plan completo, cualquier cosa me escribes directo.', minutesAgo: 20000 },
      { direction: 'inbound', body: 'listo ya pagué, gracias!', minutesAgo: 19900 },
    ],
  },
  {
    lead: {
      wa_id: '584121234567',
      profile_name: 'Andrea',
      display_name: 'Andrea',
      student_name: null,
      student_age: null,
      stage: 'engaged',
      tags: ['organico'],
      first_contact_at: minutes(95),
      cost_usd: 0.009,
    },
    messages: [
      { direction: 'inbound', body: 'hola! me pasaron tu contacto, das clases de inglés a niños?', minutesAgo: 95 },
      { direction: 'outbound_bot', body: 'hola! sí, trabajo con niños de 7 a 14. de qué edad estamos hablando?', minutesAgo: 92 },
    ],
  },
  {
    lead: {
      wa_id: '5491134567890',
      profile_name: 'Paula G.',
      display_name: 'Paula',
      student_name: 'Benja',
      student_age: 7,
      stage: 'human_handling',
      tags: ['ctwa', 'argentina', 'escalado'],
      ctwa_clid: 'DEMO_CLID_5d10ee',
      ctwa_source_id: '120209876543210',
      ctwa_headline: 'Clases de inglés para niños — primera clase gratis',
      ctwa_captured_at: minutes(300),
      bot_paused: true,
      bot_paused_reason: 'escalated:price_negotiation',
      bot_paused_at: minutes(180),
      first_contact_at: minutes(300),
      cost_usd: 0.031,
      notes: 'Pidió descuento por dos hermanos. Pendiente que Jordi responda.',
    },
    messages: [
      { direction: 'inbound', body: 'hola, tengo dos hijos, hay descuento por los dos?', minutesAgo: 300 },
      { direction: 'outbound_bot', body: 'hola! qué edades tienen?', minutesAgo: 297 },
      { direction: 'inbound', body: '7 y 10. me interesa pero necesito saber el precio por los dos', minutesAgo: 240 },
      { direction: 'outbound_bot', body: 'te entiendo. eso lo ve Jordi directamente contigo, le paso tu mensaje y te escribe en un ratito', minutesAgo: 180 },
    ],
  },
  {
    lead: {
      wa_id: '51987654321',
      profile_name: 'Carlos M.',
      display_name: null,
      student_name: null,
      student_age: null,
      stage: 'new',
      tags: ['ctwa', 'peru'],
      ctwa_clid: 'DEMO_CLID_9a44b1',
      ctwa_source_id: '120209876543212',
      ctwa_headline: 'Aprende inglés jugando — clases en vivo para niños',
      ctwa_captured_at: minutes(12),
      first_contact_at: minutes(12),
      cost_usd: 0,
    },
    messages: [{ direction: 'inbound', body: 'hola', minutesAgo: 12 }],
  },
  {
    lead: {
      wa_id: '593991112233',
      profile_name: 'Verónica',
      display_name: 'Vero',
      student_name: 'Daniela',
      student_age: 11,
      stage: 'qualified',
      tags: ['organico', 'ecuador'],
      first_contact_at: minutes(4320),
      cost_usd: 0.067,
      notes: 'Le interesa el plan completo, está comparando horarios.',
    },
    messages: [
      { direction: 'inbound', body: 'buenas tardes, quisiera saber sobre las clases', minutesAgo: 4320 },
      { direction: 'outbound_bot', body: 'hola! con gusto. qué edad tiene la niña o el niño?', minutesAgo: 4318 },
      { direction: 'inbound', body: 'Daniela tiene 11 años', minutesAgo: 4300 },
      { direction: 'outbound_bot', body: 'y qué es lo que más te gustaría que mejore, hablar, entender, o la parte del colegio?', minutesAgo: 4298 },
      { direction: 'inbound', body: 'hablar sobre todo, en el colegio va bien pero no practica', minutesAgo: 4200 },
    ],
  },
  {
    lead: {
      wa_id: '573109998877',
      profile_name: 'Jhon',
      display_name: null,
      student_name: null,
      student_age: null,
      stage: 'lost',
      tags: ['organico'],
      first_contact_at: minutes(43200),
      last_inbound_at: minutes(43200),
      cost_usd: 0.004,
      notes: 'Preguntó y no volvió a responder.',
    },
    messages: [
      { direction: 'inbound', body: 'precio?', minutesAgo: 43200 },
      { direction: 'outbound_bot', body: 'hola! antes de hablar de planes, cuántos años tiene el estudiante?', minutesAgo: 43198 },
    ],
  },
  {
    lead: {
      wa_id: '50688776655',
      profile_name: 'Gaby',
      display_name: 'Gaby',
      student_name: 'Emilia',
      student_age: 8,
      stage: 'trial_completed',
      tags: ['ctwa', 'costa-rica'],
      ctwa_clid: 'DEMO_CLID_1c9f03',
      ctwa_source_id: '120209876543211',
      ctwa_headline: 'Inglés para niños de 7 a 14 — profesor en vivo',
      ctwa_captured_at: minutes(10080),
      first_contact_at: minutes(10080),
      cost_usd: 0.089,
      notes: 'Tomó la clase de prueba, le gustó. Decide con el papá esta semana.',
    },
    messages: [
      { direction: 'inbound', body: 'hola vi el anuncio', minutesAgo: 10080 },
      { direction: 'outbound_bot', body: 'hola! cuántos años tiene tu hija o hijo?', minutesAgo: 10078 },
      { direction: 'inbound', body: '8 años, Emilia', minutesAgo: 10000 },
      { direction: 'outbound_bot', body: 'qué bien. ya ha tenido clases de inglés antes o empezaría desde cero?', minutesAgo: 9998 },
      { direction: 'inbound', body: 'desde cero prácticamente', minutesAgo: 9900 },
      { direction: 'outbound_bot', body: 'perfecto, con esa edad se avanza rapidísimo. te agendo una clase de prueba?', minutesAgo: 9898 },
      { direction: 'inbound', body: 'si porfa', minutesAgo: 9800 },
      { direction: 'outbound_human', body: 'Hola Gaby! Qué tal les pareció la clase de Emilia?', minutesAgo: 1440 },
    ],
  },
];

/** Populates a store with demo leads, conversations and one queued message. */
export async function seedDemoData(store: Store): Promise<void> {
  for (const entry of SEED) {
    const msgs = [...entry.messages].sort((a, b) => b.minutesAgo - a.minutesAgo);
    const lastInbound = msgs.filter((m) => m.direction === 'inbound').at(-1);
    const last = msgs.at(-1);

    const lead = await store.upsertLead(entry.lead.wa_id, {
      ...entry.lead,
      last_message_at: last ? minutes(last.minutesAgo) : null,
      last_inbound_at: lastInbound ? minutes(lastInbound.minutesAgo) : null,
    });

    let seq = 0;
    for (const m of msgs) {
      await store.insertMessage({
        lead_id: lead.id,
        wa_message_id: `demo.${lead.wa_id}.${seq++}`,
        direction: m.direction,
        body: m.body,
        raw: { demo: true },
        created_at: minutes(m.minutesAgo),
      });
    }
  }

  // One message waiting in the queue, so the dashboard's "pending" tile is not
  // permanently zero in demo mode.
  const andrea = await store.getLeadByWaId('584121234567');
  if (andrea) {
    await store.enqueue({
      lead_id: andrea.id,
      body: 'quedo atenta! cualquier cosa me escribes por acá',
      send_after: new Date(Date.now() + 90_000).toISOString(),
    });
  }
}
