import { runAfterResponse } from '../lib/async.js';
import { config as appConfig } from '../lib/config.js';
import { header, queryParam, readRawBody, sendJson, sendText, type Req, type Res } from '../lib/http.js';
import { log } from '../lib/logger.js';
import { verifyMetaSignature } from '../lib/meta/signature.js';
import type { WebhookPayload } from '../lib/meta/types.js';
import { processPayload } from '../lib/webhook/process.js';

/**
 * Never let a body parser touch this route: the signature is computed over the
 * exact bytes Meta sent (SPEC §3.2).
 */
export const config = { api: { bodyParser: false } };

export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method === 'GET') return handleVerification(req, res);
  if (req.method === 'POST') return handleEvent(req, res);

  res.setHeader('allow', 'GET, POST');
  sendText(res, 405, 'method not allowed');
}

/** SPEC §3.1 — the one-time handshake Meta performs when you register the URL. */
function handleVerification(req: Req, res: Res): void {
  const mode = queryParam(req, 'hub.mode');
  const token = queryParam(req, 'hub.verify_token');
  const challenge = queryParam(req, 'hub.challenge');

  const expected = appConfig.meta.verifyToken;
  if (mode === 'subscribe' && expected && token === expected) {
    log.info('webhook.verified', { human: 'WhatsApp verificó correctamente la dirección del webhook.' });
    sendText(res, 200, challenge ?? '');
    return;
  }

  log.warn('webhook.verification_rejected', {
    mode,
    tokenConfigured: Boolean(expected),
    human: 'Se rechazó un intento de verificación del webhook.',
  });
  sendText(res, 403, 'forbidden');
}

async function handleEvent(req: Req, res: Res): Promise<void> {
  const startedAt = Date.now();

  let raw: Buffer;
  try {
    raw = await readRawBody(req);
  } catch (err) {
    log.error('webhook.body_read_failed', { error: String(err) });
    sendJson(res, 400, { error: 'unreadable body' });
    return;
  }

  const signature = verifyMetaSignature(
    raw,
    header(req, 'x-hub-signature-256'),
    appConfig.meta.appSecret,
  );

  if (!signature.ok) {
    log.warn('webhook.signature_rejected', {
      reason: signature.reason,
      human: 'Se rechazó una llamada al webhook que no venía firmada por WhatsApp.',
    });
    sendJson(res, 401, { error: 'invalid signature' });
    return;
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(raw.toString('utf8')) as WebhookPayload;
  } catch (err) {
    log.error('webhook.invalid_json', { error: String(err) });
    // 200 on purpose: having Meta retry malformed JSON helps nobody.
    sendJson(res, 200, { ok: true, ignored: 'invalid json' });
    return;
  }

  log.info('webhook.received', {
    entries: payload.entry?.length ?? 0,
    ms: Date.now() - startedAt,
  });

  // SPEC §3.3: answer first, work afterwards. Meta retries anything slower than
  // 5 seconds, and a retry means a duplicate reply to a real parent.
  sendJson(res, 200, { ok: true });

  runAfterResponse(
    processPayload(payload).then((result) => {
      log.info('webhook.processed', { ...result, ms: Date.now() - startedAt });
    }),
    'webhook.process',
  );
}
