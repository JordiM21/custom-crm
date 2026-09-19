import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { header, sendJson, type Req, type Res } from '../http.js';

/**
 * Admin panel authentication.
 *
 * One shared password, as CLAUDE.md specifies. The password is exchanged for a
 * signed, expiring cookie so it is not resent on every request and cannot be
 * read back out of the cookie.
 */

const COOKIE_NAME = 'letjunior_admin';
const TTL_MS = 12 * 60 * 60 * 1000;

function sign(payload: string): string {
  return createHmac('sha256', config.admin.sessionSecret || 'unset').update(payload).digest('hex');
}

export function issueToken(): string {
  const expires = Date.now() + TTL_MS;
  const nonce = randomBytes(8).toString('hex');
  const payload = `${expires}.${nonce}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;

  const [expiresRaw, nonce, signature] = parts as [string, string, string];
  const expires = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;

  const expected = sign(`${expiresRaw}.${nonce}`);
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function passwordMatches(candidate: string): boolean {
  const expected = config.admin.password;
  if (!expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function setSessionCookie(res: Res, token: string): void {
  const secure = config.environment === 'production' ? ' Secure;' : '';
  res.setHeader(
    'set-cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict;${secure} Max-Age=${TTL_MS / 1000}`,
  );
}

export function clearSessionCookie(res: Res): void {
  res.setHeader('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function readCookie(req: Req, name: string): string | undefined {
  const raw = header(req, 'cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

export function isAuthenticated(req: Req): boolean {
  return verifyToken(readCookie(req, COOKIE_NAME));
}

/**
 * Guards an admin route. Returns false when the response has already been sent.
 *
 * When ADMIN_PASSWORD is unset the panel is open, which is the only workable
 * first-run state — but it says so loudly in the panel rather than pretending
 * to be protected.
 */
export function requireAuth(req: Req, res: Res): boolean {
  if (!config.admin.password) return true;
  if (isAuthenticated(req)) return true;

  sendJson(res, 401, {
    error: 'unauthorised',
    message: 'Tu sesión expiró. Vuelve a entrar con tu contraseña.',
  });
  return false;
}

export function authIsEnforced(): boolean {
  return Boolean(config.admin.password);
}
