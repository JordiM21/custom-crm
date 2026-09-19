import { randomUUID } from 'node:crypto';
import { runAgent } from './agent/run.js';
import { log } from './logger.js';
import { drainQueue } from './queue.js';
import { getStore } from './store/index.js';
import type { Lead, Message } from './store/types.js';

/**
 * Practice mode, behind the panel's "Probar" screen.
 *
 * It exists because connecting a real WhatsApp number takes days of Meta
 * paperwork, and until that is done there is no way to find out whether the bot
 * actually sounds right. This runs a message through the real pipeline — the
 * real prompt, the real knowledge file, the real model, the real tools — and
 * stops only at the point where a message would reach a phone.
 *
 * Practice leads are marked, and `lib/queue.ts` refuses to send for a marked
 * lead, so a test conversation cannot reach a real parent even in production.
 */

export const SIMULATION_TAG = 'simulacion';
export const SIMULATION_WA_ID = 'sim-prueba';

/** True when this lead is a practice conversation, never a real parent. */
export function isSimulated(lead: Pick<Lead, 'wa_id' | 'tags'>): boolean {
  return lead.tags.includes(SIMULATION_TAG) || lead.wa_id.startsWith('sim-');
}

export interface SimulationTurn {
  direction: Message['direction'];
  body: string | null;
  created_at: string;
}

export interface SimulationResult {
  leadId: string;
  status: string;
  detail?: string;
  messages: SimulationTurn[];
  lead: {
    stage: string;
    student_name: string | null;
    student_age: number | null;
    display_name: string | null;
    bot_paused: boolean;
    bot_paused_reason: string | null;
    notes: string | null;
    cost_usd: number;
  };
}

async function practiceLead(): Promise<Lead> {
  const store = await getStore();
  const existing = await store.getLeadByWaId(SIMULATION_WA_ID);
  if (existing) return existing;

  return store.upsertLead(SIMULATION_WA_ID, {
    profile_name: 'Conversación de prueba',
    tags: [SIMULATION_TAG],
  });
}

/**
 * Sends one message as if a parent had written it, and returns the whole
 * conversation once the bot has answered.
 */
export async function simulateInbound(text: string): Promise<SimulationResult> {
  const store = await getStore();
  const lead = await practiceLead();
  const now = new Date().toISOString();

  await store.insertMessage({
    lead_id: lead.id,
    wa_message_id: `sim.${randomUUID()}`,
    direction: 'inbound',
    body: text,
    raw: { simulated: true },
    created_at: now,
  });

  await store.updateLead(lead.id, { last_message_at: now, last_inbound_at: now });

  const run = await runAgent(lead.id, { text, waMessageId: `sim.${randomUUID()}` });

  // ignorePacing: the 8-45 second human delay is right for a real parent and
  // pointless when someone is sitting in front of the screen judging wording.
  await drainQueue(25, { ignorePacing: true });

  const [messages, fresh] = await Promise.all([
    store.listMessages(lead.id, 100),
    store.getLeadById(lead.id),
  ]);

  log.info('simulator.turn', { status: run.status, queued: run.queued });

  const current = fresh ?? lead;
  return {
    leadId: current.id,
    status: run.status,
    detail: run.detail,
    messages: messages.map((m) => ({
      direction: m.direction,
      body: m.body,
      created_at: m.created_at,
    })),
    lead: {
      stage: current.stage,
      student_name: current.student_name,
      student_age: current.student_age,
      display_name: current.display_name,
      bot_paused: current.bot_paused,
      bot_paused_reason: current.bot_paused_reason,
      notes: current.notes,
      cost_usd: current.cost_usd,
    },
  };
}

/** Reads the practice conversation without sending anything. */
export async function readSimulation(): Promise<SimulationResult | null> {
  const store = await getStore();
  const lead = await store.getLeadByWaId(SIMULATION_WA_ID);
  if (!lead) return null;

  const messages = await store.listMessages(lead.id, 100);
  return {
    leadId: lead.id,
    status: 'idle',
    messages: messages.map((m) => ({
      direction: m.direction,
      body: m.body,
      created_at: m.created_at,
    })),
    lead: {
      stage: lead.stage,
      student_name: lead.student_name,
      student_age: lead.student_age,
      display_name: lead.display_name,
      bot_paused: lead.bot_paused,
      bot_paused_reason: lead.bot_paused_reason,
      notes: lead.notes,
      cost_usd: lead.cost_usd,
    },
  };
}

/** Wipes the practice conversation so the next test starts from nothing. */
export async function resetSimulation(): Promise<void> {
  const store = await getStore();
  const lead = await store.getLeadByWaId(SIMULATION_WA_ID);
  if (!lead) return;

  await store.cancelQueueForLead(lead.id, 'simulation_reset');
  await store.deleteMessages(lead.id);
  await store.updateLead(lead.id, {
    stage: 'new',
    student_name: null,
    student_age: null,
    display_name: null,
    notes: null,
    bot_paused: false,
    bot_paused_reason: null,
    bot_paused_at: null,
    cost_usd: 0,
    last_message_at: null,
    last_inbound_at: null,
  });

  log.info('simulator.reset', { lead_id: lead.id });
}
