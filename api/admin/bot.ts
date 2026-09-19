import { requireAuth } from '../../lib/admin/auth.js';
import { readJsonBody, sendJson, type Req, type Res } from '../../lib/http.js';
import { getBotState, setBotEnabled } from '../../lib/killswitch.js';
import { log } from '../../lib/logger.js';

/**
 * The kill switch (SPEC §9).
 *
 * Takes effect immediately, with no redeploy — during an incident, waiting a
 * minute for a build is not an option.
 */
export default async function handler(req: Req, res: Res): Promise<void> {
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    sendJson(res, 200, await getBotState());
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const body = await readJsonBody<{ enabled?: boolean }>(req);
  if (typeof body?.enabled !== 'boolean') {
    sendJson(res, 400, { error: 'enabled must be true or false' });
    return;
  }

  const state = await setBotEnabled(body.enabled);

  log.warn('admin.kill_switch', {
    requested: body.enabled,
    effective: state.enabled,
    human: body.enabled
      ? 'Encendiste el bot desde el panel.'
      : 'Apagaste el bot desde el panel. Los mensajes se guardan pero nadie responde.',
  });

  if (body.enabled && !state.enabled) {
    sendJson(res, 200, {
      ...state,
      message:
        'No se pudo encender: el servidor tiene BOT_ENABLED en false. Cámbialo en Vercel y vuelve a desplegar.',
    });
    return;
  }

  sendJson(res, 200, state);
}
