import { log } from './logger.js';

/**
 * Keeps work alive after the HTTP response has been sent (SPEC §3.3).
 *
 * Vercel freezes a function the moment it responds unless the work is handed to
 * `waitUntil`. Locally, and anywhere the helper is unavailable, we simply keep
 * the promise running — the process is not frozen there.
 */
export function runAfterResponse(work: Promise<unknown>, label: string): void {
  const guarded = work.catch((err) => {
    log.error('background.failed', { label, error: String(err) });
  });

  void import('@vercel/functions')
    .then(({ waitUntil }) => waitUntil(guarded))
    .catch(() => {
      // Not running on Vercel. The promise is already in flight.
    });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
