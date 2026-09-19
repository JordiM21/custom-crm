import { requireAuth } from '../../lib/admin/auth.js';
import { queryParam, sendJson, type Req, type Res } from '../../lib/http.js';
import { getStore } from '../../lib/store/index.js';
import { isStage, STAGE_LABELS, type Stage } from '../../lib/store/types.js';
import { hoursSinceInbound } from '../../lib/whatsapp.js';

/** The lead list behind the panel's main table. */
export default async function handler(req: Req, res: Res): Promise<void> {
  if (!requireAuth(req, res)) return;

  const store = await getStore();

  const stageParam = queryParam(req, 'stage');
  const stage: Stage | 'all' = stageParam && isStage(stageParam) ? stageParam : 'all';
  const search = queryParam(req, 'search')?.trim() || undefined;
  const pausedParam = queryParam(req, 'paused');
  const limit = Math.min(Number.parseInt(queryParam(req, 'limit') ?? '50', 10) || 50, 200);
  const offset = Math.max(Number.parseInt(queryParam(req, 'offset') ?? '0', 10) || 0, 0);

  const { rows, total } = await store.listLeads({
    stage,
    search,
    paused: pausedParam === 'true' ? true : pausedParam === 'false' ? false : undefined,
    limit,
    offset,
  });

  sendJson(res, 200, {
    total,
    limit,
    offset,
    stages: STAGE_LABELS,
    leads: rows.map((lead) => {
      const hours = hoursSinceInbound(lead.last_inbound_at);
      return {
        id: lead.id,
        wa_id: lead.wa_id,
        name: lead.display_name ?? lead.profile_name ?? lead.wa_id,
        student_name: lead.student_name,
        student_age: lead.student_age,
        stage: lead.stage,
        stage_label: STAGE_LABELS[lead.stage],
        tags: lead.tags,
        from_ad: Boolean(lead.ctwa_clid),
        bot_paused: lead.bot_paused,
        bot_paused_reason: lead.bot_paused_reason,
        last_message_at: lead.last_message_at,
        first_contact_at: lead.first_contact_at,
        // The panel shows "can still reply" rather than the raw timestamp,
        // because that is the decision the operator is actually making.
        window_open: hours !== null && hours < 24,
        hours_since_inbound: hours === null ? null : Math.round(hours),
        needs_attention: lead.bot_paused,
      };
    }),
  });
}
