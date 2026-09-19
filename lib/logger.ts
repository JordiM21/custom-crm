/**
 * Structured JSON logging to stdout (SPEC §9).
 *
 * Two audiences:
 *   - stdout, for Vercel's log viewer when something needs debugging
 *   - the `events` ring buffer, surfaced in the admin panel's Activity page so
 *     the operator never has to open a console to know what happened
 *
 * Secrets are redacted on the way out. The ring buffer is per-instance and
 * therefore lossy on serverless; anything that must survive goes in the
 * database, not here.
 */

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  ts: string;
  level: Level;
  event: string;
  /** Plain-Spanish-free, plain-language message for the admin panel. */
  human?: string;
  [key: string]: unknown;
}

const SECRET_KEYS = [
  'access_token',
  'accessToken',
  'apiKey',
  'api_key',
  'authorization',
  'password',
  'secret',
  'serviceRoleKey',
  'service_role_key',
  'token',
];

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.some((s) => k.toLowerCase().includes(s.toLowerCase()))) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

const RING_SIZE = 200;
const ring: LogEvent[] = [];

function emit(level: Level, event: string, data: Record<string, unknown> = {}): void {
  const entry: LogEvent = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(redact(data) as Record<string, unknown>),
  };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();

  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, data?: Record<string, unknown>) => emit('debug', event, data),
  info: (event: string, data?: Record<string, unknown>) => emit('info', event, data),
  warn: (event: string, data?: Record<string, unknown>) => emit('warn', event, data),
  error: (event: string, data?: Record<string, unknown>) => emit('error', event, data),
};

/** Most recent events first — what the Activity page renders. */
export function recentEvents(limit = 100): LogEvent[] {
  return ring.slice(-limit).reverse();
}

/** Turns any thrown value into something safe to log and to show a human. */
export function describeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}
