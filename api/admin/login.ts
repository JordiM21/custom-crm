import {
  authIsEnforced,
  clearSessionCookie,
  isAuthenticated,
  issueToken,
  passwordMatches,
  setSessionCookie,
} from '../../lib/admin/auth.js';
import { readJsonBody, sendJson, type Req, type Res } from '../../lib/http.js';
import { log } from '../../lib/logger.js';

/** Exchanges the shared password for a signed, expiring session cookie. */
export default async function handler(req: Req, res: Res): Promise<void> {
  if (req.method === 'GET') {
    sendJson(res, 200, {
      required: authIsEnforced(),
      authenticated: !authIsEnforced() || isAuthenticated(req),
    });
    return;
  }

  if (req.method === 'DELETE') {
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST, DELETE');
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  if (!authIsEnforced()) {
    sendJson(res, 200, { ok: true, required: false });
    return;
  }

  const body = await readJsonBody<{ password?: string }>(req);
  if (!body?.password || !passwordMatches(body.password)) {
    log.warn('admin.login_failed', { human: 'Alguien escribió mal la contraseña del panel.' });
    // Deliberately vague, and deliberately not rate-limited here — Vercel's
    // platform-level protections cover brute force better than a counter that
    // resets on every cold start would.
    sendJson(res, 401, { error: 'wrong_password', message: 'Contraseña incorrecta.' });
    return;
  }

  setSessionCookie(res, issueToken());
  log.info('admin.login', { human: 'Entraste al panel.' });
  sendJson(res, 200, { ok: true });
}
