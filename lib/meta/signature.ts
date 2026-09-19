import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Meta's `X-Hub-Signature-256` header against the raw request body
 * (SPEC §3.2).
 *
 * This endpoint is public and anything accepted here ends up on a real parent's
 * phone, so a failed or missing signature is a hard reject — never a warning.
 */
export function verifyMetaSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): { ok: true } | { ok: false; reason: string } {
  if (!appSecret) return { ok: false, reason: 'app_secret_not_configured' };
  if (!signatureHeader) return { ok: false, reason: 'missing_signature_header' };

  const [scheme, provided] = signatureHeader.split('=');
  if (scheme !== 'sha256' || !provided) {
    return { ok: false, reason: 'malformed_signature_header' };
  }

  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');

  // timingSafeEqual throws on length mismatch, so check that first.
  if (provided.length !== expected.length) {
    return { ok: false, reason: 'signature_mismatch' };
  }

  const equal = timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  return equal ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

/** Test helper: produces the header Meta would send for a given body. */
export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
  return `sha256=${createHmac('sha256', appSecret).update(body).digest('hex')}`;
}
