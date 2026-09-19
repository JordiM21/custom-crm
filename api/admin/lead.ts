import { requireAuth } from '../../lib/admin/auth.js';
import { queryParam, readJsonBody, sendJson, type Req, type Res } from '../../lib/http.js';
import { log } from '../../lib/logger.js';
import { getStore } from '../../lib/store/index.js';
import { isStage, STAGE_LABELS, type Lead } from '../../lib/store/types.js';
import { hoursSinceInbound } from '../../lib/whatsapp.js';

/**
 * One lead: its details, its conversation, and the two actions the operator
 * actually takes — pause the bot, or let it resume.
 *
 * This is not an inbox. There is no reply box: Jordi answers from his own
 * phone, and the echo of that reply is what pauses the bot (SPEC §4.3).
 */
export default async function handler(req: Req, res: Res): Promise<void> {
  if (!requireAuth(req, res)) return;

  const store = await getStore();
  const id = queryParam(req, 'id');
  if (!id) {
    sendJson(res, 400, { error: 'missing id' });
    return;
  }

  const lead = await store.getLeadById(id);
  if (!lead) {
    sendJson(res, 404, { error: 'not_found', message: 'Ese contacto ya no existe.' });
    return;
  }

  if (req.method === 'PATCH' || req.method === 'POST') {
    return update(req, res, lead);
  }

  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET, PATCH');
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const [messages, conversions] = await Promise.all([
    store.listMessages(lead.id, 200),
    store.listConversionEvents(lead.id),
  ]);

  const hours = hoursSinceInbound(lead.last_inbound_at);

  sendJson(res, 200, {
    lead: {
      ...lead,
      name: lead.display_name ?? lead.profile_name ?? lead.wa_id,
      stage_label: STAGE_LABELS[lead.stage],
      window_open: hours !== null && hours < 24,
      hours_since_inbound: hours === null ? null : Math.round(hours),
      whatsapp_url: `https://wa.me/${lead.wa_id}`,
    },
    messages: messages.map((m) => ({
      id: m.id,
      direction: m.direction,
      body: m.body,
      created_at: m.created_at,
    })),
    conversions: conversions.map((c) => ({
      event_name: c.event_name,
      value: c.value,
      sent_to_meta: c.sent_to_meta,
      attributable: Boolean(c.ctwa_clid),
      created_at: c.created_at,
    })),
    stages: STAGE_LABELS,
  });
}

interface UpdateBody {
  action?: 'pause' | 'resume';
  stage?: string;
  notes?: string;
  display_name?: string;
  student_name?: string;
  student_age?: number | null;
}

async function update(req: Req, res: Res, lead: Lead): Promise<void> {
  const body = await readJsonBody<UpdateBody>(req);
  if (!body) {
    sendJson(res, 400, { error: 'invalid body' });
    return;
  }

  const store = await getStore();
  const patch: Partial<Lead> = {};

  if (body.action === 'pause') {
    patch.bot_paused = true;
    patch.bot_paused_reason = 'paused_from_panel';
    patch.bot_paused_at = new Date().toISOString();
    await store.cancelQueueForLead(lead.id, 'paused_from_panel');
  }

  if (body.action === 'resume') {
    patch.bot_paused = false;
    patch.bot_paused_reason = null;
    patch.bot_paused_at = null;
    // Leaving the lead parked in human_handling would keep it out of the
    // pipeline view even though the bot is talking again.
    if (lead.stage === 'human_handling') patch.stage = 'engaged';
  }

  if (typeof body.stage === 'string') {
    if (!isStage(body.stage)) {
      sendJson(res, 400, { error: 'bad_stage', message: 'Esa etapa no existe.' });
      return;
    }
    patch.stage = body.stage;
  }

  if (typeof body.notes === 'string') patch.notes = body.notes;
  if (typeof body.display_name === 'string') patch.display_name = body.display_name.trim() || null;
  if (typeof body.student_name === 'string') patch.student_name = body.student_name.trim() || null;

  if (body.student_age === null) {
    patch.student_age = null;
  } else if (typeof body.student_age === 'number' && Number.isFinite(body.student_age)) {
    patch.student_age = Math.round(body.student_age);
  }

  if (Object.keys(patch).length === 0) {
    sendJson(res, 400, { error: 'nothing_to_update' });
    return;
  }

  const updated = await store.updateLead(lead.id, patch);
  log.info('admin.lead_updated', { lead_id: lead.id, fields: Object.keys(patch) });

  sendJson(res, 200, {
    ok: true,
    lead: { ...updated, stage_label: STAGE_LABELS[updated.stage] },
  });
}
