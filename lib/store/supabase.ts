import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import type {
  ConversionEvent,
  Direction,
  Lead,
  LeadFilter,
  Message,
  QueueItem,
  Stats,
  Store,
} from './types.js';

/** Postgres unique-violation. This is how idempotency is detected. */
const UNIQUE_VIOLATION = '23505';

export class SupabaseStore implements Store {
  readonly kind = 'supabase' as const;
  private db: SupabaseClient;

  constructor() {
    this.db = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  private fail(context: string, error: { message: string } | null): never {
    throw new Error(`${context}: ${error?.message ?? 'unknown database error'}`);
  }

  async getLeadById(id: string): Promise<Lead | null> {
    const { data, error } = await this.db.from('leads').select('*').eq('id', id).maybeSingle();
    if (error) this.fail('getLeadById', error);
    return (data as Lead) ?? null;
  }

  async getLeadByWaId(waId: string): Promise<Lead | null> {
    const { data, error } = await this.db.from('leads').select('*').eq('wa_id', waId).maybeSingle();
    if (error) this.fail('getLeadByWaId', error);
    return (data as Lead) ?? null;
  }

  async upsertLead(waId: string, patch: Partial<Lead>): Promise<Lead> {
    const existing = await this.getLeadByWaId(waId);
    if (existing) {
      // Only write fields that actually change, so we never clobber a value a
      // human set from the panel with a null from a webhook payload.
      const delta: Partial<Lead> = {};
      for (const [k, v] of Object.entries(patch) as [keyof Lead, unknown][]) {
        if (v !== undefined && v !== null && v !== existing[k]) {
          (delta as Record<string, unknown>)[k] = v;
        }
      }
      if (Object.keys(delta).length === 0) return existing;
      return this.updateLead(existing.id, delta);
    }

    const { data, error } = await this.db
      .from('leads')
      .insert({ wa_id: waId, ...patch })
      .select()
      .single();

    if (error) {
      // Two webhook deliveries for a brand new lead can race here.
      if (error.code === UNIQUE_VIOLATION) {
        const raced = await this.getLeadByWaId(waId);
        if (raced) return raced;
      }
      this.fail('upsertLead', error);
    }
    return data as Lead;
  }

  async updateLead(id: string, patch: Partial<Lead>): Promise<Lead> {
    const { data, error } = await this.db
      .from('leads')
      .update(patch)
      .eq('id', id)
      .select()
      .single();
    if (error) this.fail('updateLead', error);
    return data as Lead;
  }

  async listLeads(filter: LeadFilter): Promise<{ rows: Lead[]; total: number }> {
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    let q = this.db.from('leads').select('*', { count: 'exact' });
    if (filter.stage && filter.stage !== 'all') q = q.eq('stage', filter.stage);
    if (filter.paused !== undefined) q = q.eq('bot_paused', filter.paused);
    if (filter.search) {
      const term = `%${filter.search.replace(/[%_]/g, '')}%`;
      q = q.or(
        [
          `wa_id.ilike.${term}`,
          `profile_name.ilike.${term}`,
          `display_name.ilike.${term}`,
          `student_name.ilike.${term}`,
        ].join(','),
      );
    }

    const { data, error, count } = await q
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);

    if (error) this.fail('listLeads', error);
    return { rows: (data ?? []) as Lead[], total: count ?? 0 };
  }

  async insertMessage(
    msg: Omit<Message, 'id' | 'created_at'> & { created_at?: string },
  ): Promise<{ inserted: boolean; message: Message }> {
    const { data, error } = await this.db.from('messages').insert(msg).select().single();

    if (error) {
      if (error.code === UNIQUE_VIOLATION && msg.wa_message_id) {
        const { data: existing, error: readError } = await this.db
          .from('messages')
          .select('*')
          .eq('wa_message_id', msg.wa_message_id)
          .single();
        if (readError) this.fail('insertMessage:duplicate-lookup', readError);
        return { inserted: false, message: existing as Message };
      }
      this.fail('insertMessage', error);
    }
    return { inserted: true, message: data as Message };
  }

  async listMessages(leadId: string, limit = 30): Promise<Message[]> {
    const { data, error } = await this.db
      .from('messages')
      .select('*')
      .eq('lead_id', leadId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) this.fail('listMessages', error);
    // Query is newest-first for the LIMIT; callers want oldest-first.
    return ((data ?? []) as Message[]).reverse();
  }

  async countMessagesSince(leadId: string, direction: Direction, sinceIso: string): Promise<number> {
    const { count, error } = await this.db
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', leadId)
      .eq('direction', direction)
      .gte('created_at', sinceIso);
    if (error) this.fail('countMessagesSince', error);
    return count ?? 0;
  }

  async enqueue(
    item: Omit<QueueItem, 'id' | 'created_at' | 'sent_at' | 'cancelled_at' | 'attempts' | 'last_error'>,
  ): Promise<QueueItem> {
    const { data, error } = await this.db.from('outbound_queue').insert(item).select().single();
    if (error) this.fail('enqueue', error);
    return data as QueueItem;
  }

  async dueQueueItems(nowIso: string, limit = 25): Promise<QueueItem[]> {
    const { data, error } = await this.db
      .from('outbound_queue')
      .select('*')
      .is('sent_at', null)
      .is('cancelled_at', null)
      .lt('attempts', 3)
      .lte('send_after', nowIso)
      .order('send_after', { ascending: true })
      .limit(limit);
    if (error) this.fail('dueQueueItems', error);
    return (data ?? []) as QueueItem[];
  }

  async markQueueSent(id: string): Promise<void> {
    const { error } = await this.db
      .from('outbound_queue')
      .update({ sent_at: new Date().toISOString() })
      .eq('id', id);
    if (error) this.fail('markQueueSent', error);
  }

  async markQueueFailed(id: string, message: string): Promise<void> {
    const { data, error } = await this.db
      .from('outbound_queue')
      .select('attempts')
      .eq('id', id)
      .single();
    if (error) this.fail('markQueueFailed:read', error);
    const attempts = ((data as { attempts: number } | null)?.attempts ?? 0) + 1;
    const { error: writeError } = await this.db
      .from('outbound_queue')
      .update({ attempts, last_error: message.slice(0, 500) })
      .eq('id', id);
    if (writeError) this.fail('markQueueFailed:write', writeError);
  }

  async cancelQueueForLead(leadId: string, reason: string): Promise<number> {
    const { data, error } = await this.db
      .from('outbound_queue')
      .update({ cancelled_at: new Date().toISOString(), last_error: reason })
      .eq('lead_id', leadId)
      .is('sent_at', null)
      .is('cancelled_at', null)
      .select('id');
    if (error) this.fail('cancelQueueForLead', error);
    return (data ?? []).length;
  }

  async pendingQueueCount(): Promise<number> {
    const { count, error } = await this.db
      .from('outbound_queue')
      .select('id', { count: 'exact', head: true })
      .is('sent_at', null)
      .is('cancelled_at', null);
    if (error) this.fail('pendingQueueCount', error);
    return count ?? 0;
  }

  async nextPendingSendAfter(): Promise<string | null> {
    const { data, error } = await this.db
      .from('outbound_queue')
      .select('send_after')
      .is('sent_at', null)
      .is('cancelled_at', null)
      .lt('attempts', 3)
      .order('send_after', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) this.fail('nextPendingSendAfter', error);
    return (data as { send_after: string } | null)?.send_after ?? null;
  }

  async insertConversionEvent(
    ev: Omit<ConversionEvent, 'id' | 'created_at' | 'sent_to_meta' | 'meta_response' | 'attempts'>,
  ): Promise<ConversionEvent> {
    const { data, error } = await this.db.from('conversion_events').insert(ev).select().single();
    if (error) this.fail('insertConversionEvent', error);
    return data as ConversionEvent;
  }

  async listConversionEvents(leadId?: string): Promise<ConversionEvent[]> {
    let q = this.db.from('conversion_events').select('*');
    if (leadId) q = q.eq('lead_id', leadId);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
    if (error) this.fail('listConversionEvents', error);
    return (data ?? []) as ConversionEvent[];
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    const { data, error } = await this.db
      .from('app_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) this.fail('getSetting', error);
    if (!data) return fallback;
    return (data as { value: T }).value;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    const { error } = await this.db
      .from('app_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) this.fail('setSetting', error);
  }

  async stats(): Promise<Stats> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const since = startOfDay.toISOString();

    const [leads, paused, newToday, messagesToday, queuePending] = await Promise.all([
      this.db.from('leads').select('stage', { count: 'exact' }),
      this.db.from('leads').select('id', { count: 'exact', head: true }).eq('bot_paused', true),
      this.db.from('leads').select('id', { count: 'exact', head: true }).gte('first_contact_at', since),
      this.db.from('messages').select('id', { count: 'exact', head: true }).gte('created_at', since),
      this.pendingQueueCount(),
    ]);

    if (leads.error) this.fail('stats:leads', leads.error);

    const byStage: Record<string, number> = {};
    for (const row of (leads.data ?? []) as { stage: string }[]) {
      byStage[row.stage] = (byStage[row.stage] ?? 0) + 1;
    }
    const enrolled = byStage['enrolled'] ?? 0;

    return {
      total: leads.count ?? 0,
      byStage,
      paused: paused.count ?? 0,
      newToday: newToday.count ?? 0,
      messagesToday: messagesToday.count ?? 0,
      queuePending,
      enrolled,
      monthlyRevenueUsd: enrolled * 50,
    };
  }
}
