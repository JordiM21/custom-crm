import { config } from '../../lib/config.js';
import { header, sendJson, type Req, type Res } from '../../lib/http.js';
import { log } from '../../lib/logger.js';
import { drainQueue } from '../../lib/queue.js';

/**
 * Sends whatever is due in `outbound_queue`.
 *
 * Vercel calls this on the schedule in vercel.json. It is the safety net: the
 * webhook normally sends the reply itself inside its own invocation, because
 * Vercel's free plan only runs cron jobs once a day.
 */
export default async function handler(req: Req, res: Res): Promise<void> {
  // Vercel signs its own cron calls; CRON_SECRET covers manual and external
  // triggers. Either is accepted, neither is optional in production.
  const auth = header(req, 'authorization');
  const isVercelCron = header(req, 'x-vercel-cron') !== undefined;
  const authorised =
    isVercelCron || (config.ops.cronSecret !== '' && auth === `Bearer ${config.ops.cronSecret}`);

  if (!authorised && config.environment === 'production') {
    sendJson(res, 401, { error: 'unauthorised' });
    return;
  }

  try {
    const result = await drainQueue(50);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    log.error('cron.drain_failed', { error: String(err) });
    sendJson(res, 500, { ok: false, error: String(err) });
  }
}
