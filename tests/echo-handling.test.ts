import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { MemoryStore } from '../lib/store/memory.js';
import { __setStore } from '../lib/store/index.js';
import { processPayload } from '../lib/webhook/process.js';
import type { WebhookPayload } from '../lib/meta/types.js';

function fixture(name: string): WebhookPayload {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  __setStore(store);
});

test('a reply from Jordi’s phone pauses the bot for that parent', async () => {
  await processPayload(fixture('text-message'));
  assert.equal(store.leads[0]!.bot_paused, false);

  await processPayload(fixture('echo-smb'));

  const lead = store.leads[0]!;
  assert.equal(lead.bot_paused, true);
  assert.equal(lead.bot_paused_reason, 'human_replied');
  assert.ok(lead.bot_paused_at);
});

test('the human reply is stored as part of the conversation', async () => {
  await processPayload(fixture('echo-smb'));

  const message = store.messages.find((m) => m.direction === 'outbound_human');
  assert.ok(message, 'human message stored');
  assert.equal(message!.body, 'Hola Marcela, soy Jordi. Te escribo yo directamente.');
});

test('an echo for an unknown number creates the lead', async () => {
  await processPayload(fixture('echo-smb'));

  assert.equal(store.leads.length, 1);
  assert.equal(store.leads[0]!.wa_id, '573001112233');
});

test('queued bot messages are cancelled when Jordi replies', async () => {
  await processPayload(fixture('text-message'));
  const lead = store.leads[0]!;

  // The agent queues its own reply to that message; clear it so this test is
  // only about what the echo cancels.
  store.queue = [];

  await store.enqueue({
    lead_id: lead.id,
    body: 'mensaje que ya no se debe enviar',
    send_after: new Date(Date.now() + 30_000).toISOString(),
  });
  await store.enqueue({
    lead_id: lead.id,
    body: 'este tampoco',
    send_after: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(await store.pendingQueueCount(), 2);

  await processPayload(fixture('echo-smb'));

  assert.equal(await store.pendingQueueCount(), 0);
  assert.ok(store.queue.every((q) => q.cancelled_at !== null));
});

test('a message already sent is not retroactively cancelled', async () => {
  await processPayload(fixture('text-message'));
  const lead = store.leads[0]!;

  store.queue = [];

  const sent = await store.enqueue({
    lead_id: lead.id,
    body: 'ya salio',
    send_after: new Date(Date.now() - 60_000).toISOString(),
  });
  await store.markQueueSent(sent.id);

  await processPayload(fixture('echo-smb'));

  const row = store.queue.find((q) => q.id === sent.id)!;
  assert.equal(row.cancelled_at, null);
  assert.ok(row.sent_at);
});

test('echoes are recognised under both payload shapes Meta emits', async () => {
  await processPayload(fixture('echo-alt-shape'));

  const lead = store.leads.find((l) => l.wa_id === '51987654321');
  assert.ok(lead, 'lead resolved from recipient_id');
  assert.equal(lead!.bot_paused, true);
  assert.equal(lead!.bot_paused_reason, 'human_replied');
});

test('a replayed echo does not pause twice or duplicate the message', async () => {
  await processPayload(fixture('echo-smb'));
  const pausedAt = store.leads[0]!.bot_paused_at;

  const result = await processPayload(fixture('echo-smb'));

  assert.equal(result.duplicates, 1);
  assert.equal(store.messages.filter((m) => m.direction === 'outbound_human').length, 1);
  assert.equal(store.leads[0]!.bot_paused_at, pausedAt);
});

test('another parent’s queue is untouched when Jordi replies to one lead', async () => {
  await processPayload(fixture('text-message'));
  await processPayload(fixture('ctwa-referral'));

  store.queue = [];

  const other = store.leads.find((l) => l.wa_id === '51987654321')!;
  await store.enqueue({
    lead_id: other.id,
    body: 'sigue en cola',
    send_after: new Date(Date.now() + 30_000).toISOString(),
  });

  await processPayload(fixture('echo-smb'));

  assert.equal(await store.pendingQueueCount(), 1);
  assert.equal(other.bot_paused, false);
});
