import { requireAuth } from '../../lib/admin/auth.js';
import { getProvider, isRealProvider } from '../../lib/ai/index.js';
import { knowledgeIsComplete } from '../../lib/agent/knowledge.js';
import { readJsonBody, sendJson, type Req, type Res } from '../../lib/http.js';
import { log } from '../../lib/logger.js';
import { readSimulation, resetSimulation, simulateInbound } from '../../lib/simulator.js';

/**
 * Practice mode: talk to the bot as if you were a parent, without WhatsApp.
 *
 * Real prompt, real knowledge file, real model, real tools. The only thing that
 * does not happen is the message reaching a phone.
 */
export default async function handler(req: Req, res: Res): Promise<void> {
  if (!requireAuth(req, res)) return;

  const context = {
    provider: getProvider().name,
    realProvider: isRealProvider(),
    knowledgeComplete: knowledgeIsComplete(),
  };

  if (req.method === 'GET') {
    sendJson(res, 200, { ...context, conversation: await readSimulation() });
    return;
  }

  if (req.method === 'DELETE') {
    await resetSimulation();
    sendJson(res, 200, { ok: true, ...context, conversation: null });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST, DELETE');
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const body = await readJsonBody<{ text?: string }>(req);
  const text = body?.text?.trim();

  if (!text) {
    sendJson(res, 400, { error: 'empty', message: 'Escribe un mensaje primero.' });
    return;
  }

  if (text.length > 2000) {
    sendJson(res, 400, {
      error: 'too_long',
      message: 'Ese mensaje es más largo que cualquier cosa que un padre escribiría por WhatsApp.',
    });
    return;
  }

  try {
    const conversation = await simulateInbound(text);
    sendJson(res, 200, { ...context, conversation });
  } catch (err) {
    log.error('simulator.failed', { error: String(err) });
    sendJson(res, 500, {
      error: 'failed',
      message: `No se pudo generar la respuesta: ${String(err)}`,
    });
  }
}
