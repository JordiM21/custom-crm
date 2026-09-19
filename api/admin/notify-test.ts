import { requireAuth } from '../../lib/admin/auth.js';
import { sendJson, type Req, type Res } from '../../lib/http.js';
import { configuredChannels, notifyOwner } from '../../lib/notify.js';

/**
 * Sends a test alert on every configured channel.
 *
 * The one thing you cannot find out from a config screen is whether a
 * notification actually arrives on your phone. This is how you find out
 * before a real parent is waiting on it.
 */
export default async function handler(req: Req, res: Res): Promise<void> {
  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    sendJson(res, 200, { channels: configuredChannels() });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST');
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const channels = configuredChannels();
  if (channels.length === 0) {
    sendJson(res, 400, {
      error: 'no_channels',
      message:
        'No hay ningún canal configurado todavía. Revisa "Cómo te avisamos" en esta misma página.',
    });
    return;
  }

  const result = await notifyOwner({
    kind: 'alert',
    title: 'Prueba de aviso — LET Junior',
    body: 'Si estás leyendo esto, los avisos funcionan. Este mensaje lo mandaste tú desde el panel.',
  });

  sendJson(res, 200, {
    ...result,
    message: result.silent
      ? `No se pudo entregar por ningún canal (${result.failed.map((f) => `${f.channel}: ${f.error}`).join(', ')}).`
      : `Enviado por ${result.delivered.join(' y ')}. Revisa que te haya llegado.`,
  });
}
