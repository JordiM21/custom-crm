import { randomUUID } from 'node:crypto';
import type {
  ConversionEvent,
  Direction,
  Lead,
  LeadFilter,
  Message,
  QueueItem,
  Stage,
  Stats,
  Store,
} from './types.js';

/**
 * In-memory store. Used for tests and for demo mode, so the whole product can
 * be run and judged before a Supabase project exists.
 *
 * Data lives for the lifetime of one serverless instance only. The admin panel
 * says so in plain language whenever this store is active — an operator must
 * never be left believing demo data is real.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  leads: Lead[] = [];
  messages: Message[] = [];
  queue: QueueItem[] = [];
  conversions: ConversionEvent[] = [];
  settings = new Map<string, unknown>();

  private now(): string {
    return new Date().toISOString();
  }

  async getLeadById(id: string): Promise<Lead | null> {
    return this.leads.find((l) => l.id === id) ?? null;
  }

  async getLeadByWaId(waId: string): Promise<Lead | null> {
    return this.leads.find((l) => l.wa_id === waId) ?? null;
  }

  async upsertLead(waId: string, patch: Partial<Lead>): Promise<Lead> {
    const existing = this.leads.find((l) => l.wa_id === waId);
    if (existing) {
      return this.updateLead(existing.id, patch);
    }
    const ts = this.now();
    const lead: Lead = {
      id: randomUUID(),
      wa_id: waId,
      profile_name: null,
      display_name: null,
      student_name: null,
      student_age: null,
      stage: 'new',
      tags: [],
      ctwa_clid: null,
      ctwa_source_id: null,
      ctwa_headline: null,
      ctwa_captured_at: null,
      bot_paused: false,
      bot_paused_reason: null,
      bot_paused_at: null,
      first_contact_at: ts,
      last_message_at: null,
      last_inbound_at: null,
      notes: null,
      cost_usd: 0,
      created_at: ts,
      updated_at: ts,
      ...patch,
    };
    this.leads.push(lead);
    return lead;
  }

  async updateLead(id: string, patch: Partial<Lead>): Promise<Lead> {
    const lead = this.leads.find((l) => l.id === id);
    if (!lead) throw new Error(`lead ${id} not found`);
    Object.assign(lead, patch, { updated_at: this.now() });
    return lead;
  }

  async listLeads(filter: LeadFilter): Promise<{ rows: Lead[]; total: number }> {
    let rows = [...this.leads];
    if (filter.stage && filter.stage !== 'all') {
      rows = rows.filter((l) => l.stage === filter.stage);
    }
    if (filter.paused !== undefined) {
      rows = rows.filter((l) => l.bot_paused === filter.paused);
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      rows = rows.filter((l) =>
        [l.wa_id, l.profile_name, l.display_name, l.student_name, l.notes]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    rows.sort((a, b) => {
      const at = a.last_message_at ?? a.created_at;
      const bt = b.last_message_at ?? b.created_at;
      return bt.localeCompare(at);
    });
    const total = rows.length;
    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return { rows: rows.slice(offset, offset + limit), total };
  }

  async insertMessage(
    msg: Omit<Message, 'id' | 'created_at'> & { created_at?: string },
  ): Promise<{ inserted: boolean; message: Message }> {
    if (msg.wa_message_id) {
      const dup = this.messages.find((m) => m.wa_message_id === msg.wa_message_id);
      if (dup) return { inserted: false, message: dup };
    }
    const message: Message = {
      id: randomUUID(),
      created_at: msg.created_at ?? this.now(),
      lead_id: msg.lead_id,
      wa_message_id: msg.wa_message_id,
      direction: msg.direction,
      body: msg.body,
      raw: msg.raw,
    };
    this.messages.push(message);
    return { inserted: true, message };
  }

  async listMessages(leadId: string, limit = 30): Promise<Message[]> {
    return this.messages
      .filter((m) => m.lead_id === leadId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .slice(-limit);
  }

  async deleteMessages(leadId: string): Promise<void> {
    this.messages = this.messages.filter((m) => m.lead_id !== leadId);
  }

  async countMessagesSince(leadId: string, direction: Direction, sinceIso: string): Promise<number> {
    return this.messages.filter(
      (m) => m.lead_id === leadId && m.direction === direction && m.created_at >= sinceIso,
    ).length;
  }

  async enqueue(
    item: Omit<QueueItem, 'id' | 'created_at' | 'sent_at' | 'cancelled_at' | 'attempts' | 'last_error'>,
  ): Promise<QueueItem> {
    const row: QueueItem = {
      id: randomUUID(),
      created_at: this.now(),
      sent_at: null,
      cancelled_at: null,
      attempts: 0,
      last_error: null,
      ...item,
    };
    this.queue.push(row);
    return row;
  }

  async dueQueueItems(nowIso: string, limit = 25): Promise<QueueItem[]> {
    return this.queue
      .filter((q) => !q.sent_at && !q.cancelled_at && q.send_after <= nowIso && q.attempts < 3)
      .sort((a, b) => a.send_after.localeCompare(b.send_after))
      .slice(0, limit);
  }

  async markQueueSent(id: string): Promise<void> {
    const row = this.queue.find((q) => q.id === id);
    if (row) row.sent_at = this.now();
  }

  async markQueueFailed(id: string, error: string): Promise<void> {
    const row = this.queue.find((q) => q.id === id);
    if (row) {
      row.attempts += 1;
      row.last_error = error;
    }
  }

  async cancelQueueForLead(leadId: string, reason: string): Promise<number> {
    let n = 0;
    for (const row of this.queue) {
      if (row.lead_id === leadId && !row.sent_at && !row.cancelled_at) {
        row.cancelled_at = this.now();
        row.last_error = reason;
        n += 1;
      }
    }
    return n;
  }

  async pendingQueueCount(): Promise<number> {
    return this.queue.filter((q) => !q.sent_at && !q.cancelled_at).length;
  }

  async nextPendingSendAfter(): Promise<string | null> {
    const pending = this.queue
      .filter((q) => !q.sent_at && !q.cancelled_at && q.attempts < 3)
      .map((q) => q.send_after)
      .sort();
    return pending[0] ?? null;
  }

  async insertConversionEvent(
    ev: Omit<ConversionEvent, 'id' | 'created_at' | 'sent_to_meta' | 'meta_response' | 'attempts'>,
  ): Promise<ConversionEvent> {
    const row: ConversionEvent = {
      id: randomUUID(),
      created_at: this.now(),
      sent_to_meta: false,
      meta_response: null,
      attempts: 0,
      ...ev,
    };
    this.conversions.push(row);
    return row;
  }

  async listConversionEvents(leadId?: string): Promise<ConversionEvent[]> {
    const rows = leadId ? this.conversions.filter((c) => c.lead_id === leadId) : this.conversions;
    return [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async getSetting<T>(key: string, fallback: T): Promise<T> {
    return this.settings.has(key) ? (this.settings.get(key) as T) : fallback;
  }

  async setSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, value);
  }

  async stats(): Promise<Stats> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const since = startOfDay.toISOString();

    const byStage: Record<string, number> = {};
    for (const lead of this.leads) {
      byStage[lead.stage] = (byStage[lead.stage] ?? 0) + 1;
    }
    const enrolled = byStage['enrolled'] ?? 0;

    return {
      total: this.leads.length,
      byStage,
      paused: this.leads.filter((l) => l.bot_paused).length,
      newToday: this.leads.filter((l) => l.first_contact_at >= since).length,
      messagesToday: this.messages.filter((m) => m.created_at >= since).length,
      queuePending: await this.pendingQueueCount(),
      enrolled,
      monthlyRevenueUsd: enrolled * 50,
    };
  }

  /** Test helper: wipe everything. */
  reset(): void {
    this.leads = [];
    this.messages = [];
    this.queue = [];
    this.conversions = [];
    this.settings.clear();
  }
}

export type { Stage };
