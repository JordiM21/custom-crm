export const STAGES = [
  'new',
  'engaged',
  'qualified',
  'trial_booked',
  'trial_completed',
  'enrolled',
  'lost',
  'unqualified',
  'human_handling',
] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/** Human labels, in Spanish, for the admin panel. */
export const STAGE_LABELS: Record<Stage, string> = {
  new: 'Nuevo',
  engaged: 'En conversación',
  qualified: 'Calificado',
  trial_booked: 'Clase agendada',
  trial_completed: 'Clase tomada',
  enrolled: 'Inscrito',
  lost: 'Perdido',
  unqualified: 'No califica',
  human_handling: 'Atendido por Jordi',
};

export type Direction = 'inbound' | 'outbound_bot' | 'outbound_human';

export interface Lead {
  id: string;
  wa_id: string;
  profile_name: string | null;
  display_name: string | null;
  student_name: string | null;
  student_age: number | null;
  stage: Stage;
  tags: string[];
  ctwa_clid: string | null;
  ctwa_source_id: string | null;
  ctwa_headline: string | null;
  ctwa_captured_at: string | null;
  bot_paused: boolean;
  bot_paused_reason: string | null;
  bot_paused_at: string | null;
  first_contact_at: string;
  last_message_at: string | null;
  last_inbound_at: string | null;
  notes: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  lead_id: string;
  wa_message_id: string | null;
  direction: Direction;
  body: string | null;
  raw: unknown;
  created_at: string;
}

export interface ConversionEvent {
  id: string;
  lead_id: string;
  event_name: 'Lead' | 'Schedule' | 'Purchase';
  value: number | null;
  currency: string;
  ctwa_clid: string | null;
  sent_to_meta: boolean;
  meta_response: unknown;
  attempts: number;
  created_at: string;
}

export interface QueueItem {
  id: string;
  lead_id: string;
  body: string;
  send_after: string;
  sent_at: string | null;
  cancelled_at: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

export interface LeadFilter {
  stage?: Stage | 'all';
  search?: string;
  paused?: boolean;
  limit?: number;
  offset?: number;
}

export interface Stats {
  total: number;
  byStage: Record<string, number>;
  paused: number;
  newToday: number;
  messagesToday: number;
  queuePending: number;
  enrolled: number;
  monthlyRevenueUsd: number;
}

/**
 * The only database surface the rest of the code may touch.
 *
 * Two implementations: Supabase (real) and memory (demo/tests). Keeping them
 * behind one interface is what lets the whole product run and be demoed before
 * a Supabase project exists.
 */
export interface Store {
  readonly kind: 'supabase' | 'memory';

  getLeadById(id: string): Promise<Lead | null>;
  getLeadByWaId(waId: string): Promise<Lead | null>;
  /** Creates the lead if this wa_id has never written before. */
  upsertLead(waId: string, patch: Partial<Lead>): Promise<Lead>;
  updateLead(id: string, patch: Partial<Lead>): Promise<Lead>;
  listLeads(filter: LeadFilter): Promise<{ rows: Lead[]; total: number }>;

  /**
   * Idempotent insert. Returns inserted=false when wa_message_id was already
   * stored — that is the duplicate-delivery guard from SPEC §3.4.
   */
  insertMessage(
    msg: Omit<Message, 'id' | 'created_at'> & { created_at?: string },
  ): Promise<{ inserted: boolean; message: Message }>;
  listMessages(leadId: string, limit?: number): Promise<Message[]>;
  countMessagesSince(leadId: string, direction: Direction, sinceIso: string): Promise<number>;

  enqueue(item: Omit<QueueItem, 'id' | 'created_at' | 'sent_at' | 'cancelled_at' | 'attempts' | 'last_error'>): Promise<QueueItem>;
  dueQueueItems(nowIso: string, limit?: number): Promise<QueueItem[]>;
  markQueueSent(id: string): Promise<void>;
  markQueueFailed(id: string, error: string): Promise<void>;
  cancelQueueForLead(leadId: string, reason: string): Promise<number>;
  pendingQueueCount(): Promise<number>;

  insertConversionEvent(
    ev: Omit<ConversionEvent, 'id' | 'created_at' | 'sent_to_meta' | 'meta_response' | 'attempts'>,
  ): Promise<ConversionEvent>;
  listConversionEvents(leadId?: string): Promise<ConversionEvent[]>;

  getSetting<T>(key: string, fallback: T): Promise<T>;
  setSetting(key: string, value: unknown): Promise<void>;

  stats(): Promise<Stats>;
}
