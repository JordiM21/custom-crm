import { createSign } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../logger.js';
import { formatSlotForParent, zonedDateParts, zonedTimeToUtc } from '../timezone.js';

/**
 * Google Calendar via a service account (SPEC §6).
 *
 * Signed JWT and plain fetch rather than the googleapis package: that library
 * is tens of megabytes for two endpoints, and cold starts matter here.
 */

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export interface Slot {
  startIso: string;
  endIso: string;
  /** What the parent reads, in their local wording. */
  label: string;
}

function loadServiceAccount(): ServiceAccount | null {
  if (!config.google.serviceAccountJson) return null;
  try {
    const decoded = Buffer.from(config.google.serviceAccountJson, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as ServiceAccount;
    if (!parsed.client_email || !parsed.private_key) return null;
    return parsed;
  } catch (err) {
    log.error('calendar.bad_service_account', {
      error: String(err),
      human:
        'The Google service account key could not be read. Trial classes cannot be booked until it is fixed.',
    });
    return null;
  }
}

export function calendarIsConfigured(): boolean {
  return Boolean(loadServiceAccount() && config.google.calendarId);
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;

  const account = loadServiceAccount();
  if (!account) throw new Error('google service account not configured');

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/calendar',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const signature = signer.sign(account.private_key.replace(/\\n/g, '\n')).toString('base64url');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${signature}`,
    }),
  });

  const body = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`google auth failed: ${body.error_description ?? response.status}`);
  }

  tokenCache = {
    token: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
  };
  return tokenCache.token;
}

interface BusyPeriod {
  start: string;
  end: string;
}

async function freeBusy(fromIso: string, toIso: string): Promise<BusyPeriod[]> {
  const token = await accessToken();

  const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      timeMin: fromIso,
      timeMax: toIso,
      timeZone: config.booking.timezone,
      items: [{ id: config.google.calendarId }],
    }),
  });

  const body = (await response.json()) as {
    calendars?: Record<string, { busy?: BusyPeriod[] }>;
    error?: { message?: string };
  };

  if (!response.ok) throw new Error(`freeBusy failed: ${body.error?.message ?? response.status}`);
  return body.calendars?.[config.google.calendarId]?.busy ?? [];
}

function overlaps(startMs: number, endMs: number, busy: BusyPeriod[]): boolean {
  return busy.some((period) => {
    const bStart = new Date(period.start).getTime();
    const bEnd = new Date(period.end).getTime();
    return startMs < bEnd && endMs > bStart;
  });
}

/**
 * Candidate slots inside working hours, on the hour, that are free.
 *
 * Never offers anything sooner than the configured lead time — a parent
 * accepting a slot 20 minutes from now is a class nobody is ready for.
 */
export async function findAvailableSlots(
  fromIso: string,
  toIso: string,
  preferred?: 'morning' | 'afternoon' | 'evening',
  max = 5,
): Promise<Slot[]> {
  const earliest = Date.now() + config.booking.minLeadTimeHours * 3_600_000;
  const from = Math.max(new Date(fromIso).getTime(), earliest);
  const to = new Date(toIso).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];

  const busy = await freeBusy(new Date(from).toISOString(), new Date(to).toISOString());

  const slots: Slot[] = [];
  const durationMs = config.booking.durationMinutes * 60_000;
  const tz = config.booking.timezone;

  // Walk day by day in the business's own timezone.
  for (let dayOffset = 0; dayOffset < 21 && slots.length < max; dayOffset += 1) {
    const dayAnchor = new Date(from + dayOffset * 86_400_000);
    if (dayAnchor.getTime() > to) break;

    const { year, month, day } = zonedDateParts(dayAnchor, tz);

    for (let hour = config.booking.hoursStart; hour < config.booking.hoursEnd; hour += 1) {
      if (slots.length >= max) break;
      if (preferred === 'morning' && hour >= 12) continue;
      if (preferred === 'afternoon' && (hour < 12 || hour >= 18)) continue;
      if (preferred === 'evening' && hour < 18) continue;

      const start = zonedTimeToUtc(year, month, day, hour, 0, tz);
      const startMs = start.getTime();
      const endMs = startMs + durationMs;

      if (startMs < from || endMs > to) continue;
      if (overlaps(startMs, endMs, busy)) continue;

      slots.push({
        startIso: start.toISOString(),
        endIso: new Date(endMs).toISOString(),
        label: formatSlotForParent(start, tz),
      });
    }
  }

  return slots;
}

/** True when nothing on the calendar overlaps this slot. */
export async function slotIsStillFree(startIso: string): Promise<boolean> {
  const startMs = new Date(startIso).getTime();
  const endMs = startMs + config.booking.durationMinutes * 60_000;
  const busy = await freeBusy(new Date(startMs).toISOString(), new Date(endMs).toISOString());
  return !overlaps(startMs, endMs, busy);
}

export interface CreatedEvent {
  id: string;
  htmlLink?: string;
}

export async function createEvent(
  startIso: string,
  summary: string,
  description: string,
): Promise<CreatedEvent> {
  const token = await accessToken();
  const endIso = new Date(
    new Date(startIso).getTime() + config.booking.durationMinutes * 60_000,
  ).toISOString();

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.google.calendarId)}/events`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        summary,
        description,
        start: { dateTime: startIso, timeZone: config.booking.timezone },
        end: { dateTime: endIso, timeZone: config.booking.timezone },
      }),
    },
  );

  const body = (await response.json()) as { id?: string; htmlLink?: string; error?: { message?: string } };
  if (!response.ok || !body.id) {
    throw new Error(`calendar event failed: ${body.error?.message ?? response.status}`);
  }

  return { id: body.id, htmlLink: body.htmlLink };
}
