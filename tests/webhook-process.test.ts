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

test('an inbound text message creates a lead and stores the message', async () => {
  const result = await processPayload(fixture('text-message'));

  assert.equal(result.handled, 1);
  assert.equal(result.duplicates, 0);
  assert.equal(store.leads.length, 1);

  const lead = store.leads[0]!;
  assert.equal(lead.wa_id, '573001112233');
  assert.equal(lead.profile_name, 'Marcela R.');
  assert.equal(lead.stage, 'new');

  assert.equal(store.messages.length, 1);
  const message = store.messages[0]!;
  assert.equal(message.direction, 'inbound');
  assert.equal(message.body, 'hola, quisiera informacion de las clases');
  assert.equal(message.wa_message_id, 'wamid.TEST.text.0001');
  assert.equal(message.lead_id, lead.id);
});

test('replaying the same payload five times stores exactly one message', async () => {
  for (let i = 0; i < 5; i += 1) {
    await processPayload(fixture('text-message'));
  }

  assert.equal(store.leads.length, 1, 'one lead');
  assert.equal(store.messages.length, 1, 'one message');
});

test('replays are reported as duplicates, not as handled', async () => {
  const first = await processPayload(fixture('text-message'));
  const second = await processPayload(fixture('text-message'));

  assert.equal(first.handled, 1);
  assert.equal(second.handled, 0);
  assert.equal(second.duplicates, 1);
});

test('last_inbound_at is set so the 24h window can be checked', async () => {
  await processPayload(fixture('text-message'));
  const lead = store.leads[0]!;
  assert.ok(lead.last_inbound_at, 'last_inbound_at recorded');
  assert.equal(lead.last_inbound_at, lead.last_message_at);
});

test('two different messages from the same number reuse one lead', async () => {
  const payload = fixture('text-message');
  await processPayload(payload);

  const second = fixture('text-message');
  second.entry![0]!.changes![0]!.value.messages![0]!.id = 'wamid.TEST.text.0002';
  second.entry![0]!.changes![0]!.value.messages![0]!.text!.body = 'sigues ahi?';
  await processPayload(second);

  assert.equal(store.leads.length, 1);
  assert.equal(store.messages.length, 2);
});

test('a delivery status payload does not create leads or messages', async () => {
  const result = await processPayload(fixture('status-failed'));

  assert.equal(result.handled, 0);
  assert.equal(store.leads.length, 0);
  assert.equal(store.messages.length, 0);
});

test('an account_update payload is accepted without error', async () => {
  const result = await processPayload(fixture('account-offboarded'));
  assert.equal(result.errors, 0);
});

test('an empty payload is harmless', async () => {
  const result = await processPayload({});
  assert.deepEqual(result, { handled: 0, duplicates: 0, errors: 0 });
});

test('a malformed change does not abort the rest of the batch', async () => {
  const payload = fixture('text-message');
  payload.entry![0]!.changes!.unshift({
    field: 'messages',
    value: { messages: [{ id: 'broken' } as never] },
  });

  const result = await processPayload(payload);
  assert.equal(result.handled, 1, 'the good message still landed');
});
