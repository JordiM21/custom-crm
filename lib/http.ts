import type { IncomingMessage, ServerResponse } from 'node:http';

export type Req = IncomingMessage & { query?: Record<string, string | string[]>; body?: unknown };
export type Res = ServerResponse & {
  status: (code: number) => Res;
  json: (body: unknown) => void;
  send: (body: string) => void;
};

/**
 * Reads the untouched request bytes.
 *
 * Required for Meta's signature check (SPEC §3.2): the HMAC is computed over
 * the exact bytes Meta sent, so any parse-and-reserialise breaks it. Nothing in
 * the webhook path may read `req.body` before this runs — on Vercel that getter
 * consumes the stream.
 */
export async function readRawBody(req: Req): Promise<Buffer> {
  const preParsed = (req as { rawBody?: Buffer | string }).rawBody;
  if (preParsed) {
    return Buffer.isBuffer(preParsed) ? preParsed : Buffer.from(preParsed);
  }

  if (req.readableEnded) {
    throw new Error(
      'request body was already consumed before signature verification — ' +
        'do not read req.body in the webhook path',
    );
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: Res, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

export function sendText(res: Res, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

export function queryParam(req: Req, name: string): string | undefined {
  if (req.query) {
    const v = req.query[name];
    if (Array.isArray(v)) return v[0];
    if (typeof v === 'string') return v;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.searchParams.get(name) ?? undefined;
}

export function header(req: Req, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Parses a JSON request body. Safe for routes that do not verify signatures. */
export async function readJsonBody<T>(req: Req): Promise<T | null> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body) as T;
      } catch {
        return null;
      }
    }
    return req.body as T;
  }
  try {
    const raw = await readRawBody(req);
    if (raw.length === 0) return null;
    return JSON.parse(raw.toString('utf8')) as T;
  } catch {
    return null;
  }
}
