/**
 * Timezone helpers, built on Intl rather than a date library.
 *
 * Only two operations are needed — "what time is it there" and "turn a local
 * wall-clock time into an instant" — and both are a few lines with Intl.
 */

function partsIn(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const out: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = Number.parseInt(part.value, 10);
  }
  // Intl renders midnight as hour 24 in some runtimes.
  if (out['hour'] === 24) out['hour'] = 0;
  return out;
}

/** How far ahead of UTC the zone is, at this instant, in milliseconds. */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  const asUtc = Date.UTC(
    p['year'] ?? 1970,
    (p['month'] ?? 1) - 1,
    p['day'] ?? 1,
    p['hour'] ?? 0,
    p['minute'] ?? 0,
    p['second'] ?? 0,
  );
  return asUtc - date.getTime();
}

/** Turns a wall-clock time in `timeZone` into the instant it refers to. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  // One correction is enough except exactly at a DST transition, where either
  // answer is defensible.
  const offset = zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - offset);
}

/** The calendar date in `timeZone` for an instant. */
export function zonedDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const p = partsIn(date, timeZone);
  return {
    year: p['year'] ?? 1970,
    month: p['month'] ?? 1,
    day: p['day'] ?? 1,
    hour: p['hour'] ?? 0,
    minute: p['minute'] ?? 0,
  };
}

/** "jueves 25 de septiembre, 4:00 pm" — what the parent actually reads. */
export function formatSlotForParent(date: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat('es-CO', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);

  const time = new Intl.DateTimeFormat('es-CO', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);

  return `${day}, ${time}`;
}
