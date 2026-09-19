import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

// lib/config.ts reads the environment once, at import time. node:test runs each
// test file in its own process, so these do not leak into other files.
//
// Production + Meta credentials on purpose: in development sendText dry-runs
// and reports success, which would make the all-channels-failed case
// untestable — exactly the case that matters most.
process.env['ENVIRONMENT'] = 'production';
process.env['META_ACCESS_TOKEN'] = 'test-token';
process.env['WHATSAPP_PHONE_NUMBER_ID'] = '1234567890';
process.env['OWNER_WHATSAPP_NUMBER'] = '573001112233';
process.env['RESEND_API_KEY'] = 'test-resend-key';
process.env['NOTIFY_EMAIL_TO'] = 'jordi@example.com';
process.env['NOTIFY_WEBHOOK_URL'] = 'https://ntfy.sh/let-junior-test';
process.env['PUBLIC_URL'] = 'https://panel.example.com';

const { configuredChannels, notifyOwner } = await import('../lib/notify.js');

/**
 * The point of these: a handoff nobody hears about is a lead lost, so the
 * interesting cases are the failure ones.
 */

const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[] = [];

function stubFetch(handler: (url: string) => { ok: boolean; status?: number }): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const outcome = handler(String(url));
    calls.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
    return {
      ok: outcome.ok,
      status: outcome.status ?? (outcome.ok ? 200 : 500),
      json: async () => ({}),
      text: async () => 'error detail',
    } as Response;
  }) as typeof fetch;
}

const NOTIFICATION = {
  kind: 'escalation' as const,
  title: 'Marcela necesita que le respondas',
  body: 'Motivo: está negociando el precio',
  url: 'https://panel.example.com/?lead=abc',
};

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('every configured channel is listed', () => {
  assert.deepEqual(configuredChannels().sort(), ['email', 'webhook', 'whatsapp']);
});

test('a notification goes out on all channels at once', async () => {
  stubFetch(() => ({ ok: true }));

  const result = await notifyOwner(NOTIFICATION);

  assert.equal(result.silent, false);
  assert.deepEqual([...result.delivered].sort(), ['email', 'webhook', 'whatsapp']);
  assert.equal(result.failed.length, 0);
});

test('one channel failing does not stop the others', async () => {
  // Resend is down; the webhook and WhatsApp still work.
  stubFetch((url) => ({ ok: !url.includes('resend.com'), status: 400 }));

  const result = await notifyOwner(NOTIFICATION);

  assert.equal(result.silent, false, 'Jordi was still reached');
  assert.ok(result.delivered.includes('webhook'));
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]!.channel, 'email');
});

test('when every channel fails, the result says so instead of pretending', async () => {
  stubFetch(() => ({ ok: false, status: 400 }));

  const result = await notifyOwner(NOTIFICATION);

  assert.equal(result.silent, true);
  assert.equal(result.delivered.length, 0);
  assert.equal(result.failed.length, 3);
});

test('the webhook payload carries both ready-made text and structured fields', async () => {
  stubFetch(() => ({ ok: true }));

  await notifyOwner(NOTIFICATION);

  const webhook = calls.find((c) => c.url.includes('ntfy.sh'));
  assert.ok(webhook, 'the webhook was called');

  const body = webhook!.body as Record<string, unknown>;
  // `text` is for services that just render a message; the rest is for those
  // that branch on the content.
  assert.match(String(body['text']), /Marcela necesita/);
  assert.equal(body['kind'], 'escalation');
  assert.equal(body['url'], NOTIFICATION.url);
  assert.equal(body['source'], 'letjunior-wa-agent');
});

test('the email carries the title as its subject', async () => {
  stubFetch(() => ({ ok: true }));

  await notifyOwner(NOTIFICATION);

  const email = calls.find((c) => c.url.includes('resend.com'));
  const body = email!.body as Record<string, unknown>;
  assert.equal(body['subject'], NOTIFICATION.title);
  assert.deepEqual(body['to'], ['jordi@example.com']);
  assert.match(String(body['text']), /negociando el precio/);
});

test('the panel link is included so an alert is one tap from the contact', async () => {
  stubFetch(() => ({ ok: true }));

  await notifyOwner(NOTIFICATION);

  const email = calls.find((c) => c.url.includes('resend.com'));
  assert.match(String((email!.body as Record<string, unknown>)['text']), /panel\.example\.com/);
});
