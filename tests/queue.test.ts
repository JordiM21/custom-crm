import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { setBotEnabled } from '../lib/killswitch.js';
import { drainQueue, PER_LEAD_DAILY_CAP } from '../lib/queue.js';
import { MemoryStore } from '../lib/store/memory.js';
import { __setStore } from '../lib/store/index.js';
import type { Lead } from '../lib/store/types.js';

let store: MemoryStore;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

async function leadWithDueMessage(patch: Partial<Lead> = {}): Promise<Lead> {
  const lead = await store.upsertLead('573001112233', {
    profile_name: 'Marcela R.',
    last_inbound_at: ago(60_000),
    ...patch,
  });
  await store.enqueue({
    lead_id: lead.id,
    body: 'hola! cuántos años tiene?',
    send_after: ago(1_000),
  });
  return lead;
}

beforeEach(async () => {
  store = new MemoryStore();
  __setStore(store);
  await setBotEnabled(true);
});

test('a due message is sent and recorded in the conversation', async () => {
  const lead = await leadWithDueMessage();

  const result = await drainQueue();

  assert.equal(result.sent, 1);
  assert.equal(await store.pendingQueueCount(), 0);

  const stored = store.messages.filter((m) => m.direction === 'outbound_bot');
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.lead_id, lead.id);
});

test('a message not yet due is left alone', async () => {
  const lead = await store.upsertLead('573001112233', { last_inbound_at: ago(60_000) });
  await store.enqueue({
    lead_id: lead.id,
    body: 'todavía no',
    send_after: new Date(Date.now() + 60_000).toISOString(),
  });

  const result = await drainQueue();

  assert.equal(result.sent, 0);
  assert.equal(await store.pendingQueueCount(), 1);
});

test('a lead paused while the message waited never receives it', async () => {
  const lead = await leadWithDueMessage();
  await store.updateLead(lead.id, { bot_paused: true, bot_paused_reason: 'human_replied' });

  const result = await drainQueue();

  assert.equal(result.sent, 0);
  assert.equal(result.cancelled, 1);
  assert.equal(store.messages.filter((m) => m.direction === 'outbound_bot').length, 0);
});

test('the kill switch stops the queue without losing messages', async () => {
  await leadWithDueMessage();
  await setBotEnabled(false);

  const result = await drainQueue();

  assert.equal(result.sent, 0);
  assert.equal(await store.pendingQueueCount(), 1, 'the message is still queued, not dropped');
});

test('a closed 24h window cancels the message instead of failing the send', async () => {
  await leadWithDueMessage({ last_inbound_at: ago(25 * 3_600_000) });

  const result = await drainQueue();

  assert.equal(result.sent, 0);
  assert.equal(result.cancelled, 1);
});

test('a lead with no inbound message ever is treated as outside the window', async () => {
  await leadWithDueMessage({ last_inbound_at: null });

  const result = await drainQueue();

  assert.equal(result.sent, 0);
  assert.equal(result.cancelled, 1);
});

test('the per-lead daily cap pauses the bot instead of talking forever', async () => {
  const lead = await leadWithDueMessage();

  for (let i = 0; i < PER_LEAD_DAILY_CAP; i += 1) {
    await store.insertMessage({
      lead_id: lead.id,
      wa_message_id: `bot.${i}`,
      direction: 'outbound_bot',
      body: `mensaje ${i}`,
      raw: {},
    });
  }

  const result = await drainQueue();

  assert.equal(result.sent, 0);
  assert.equal(result.cancelled, 1);

  const updated = (await store.getLeadById(lead.id))!;
  assert.equal(updated.bot_paused, true);
  assert.equal(updated.bot_paused_reason, 'rate_limit');
});

test('messages just under the cap still go out', async () => {
  const lead = await leadWithDueMessage();

  for (let i = 0; i < PER_LEAD_DAILY_CAP - 1; i += 1) {
    await store.insertMessage({
      lead_id: lead.id,
      wa_message_id: `bot.${i}`,
      direction: 'outbound_bot',
      body: `mensaje ${i}`,
      raw: {},
    });
  }

  const result = await drainQueue();
  assert.equal(result.sent, 1);
});

test('old bot messages outside the 24h lookback do not count towards the cap', async () => {
  const lead = await leadWithDueMessage();

  for (let i = 0; i < PER_LEAD_DAILY_CAP + 5; i += 1) {
    await store.insertMessage({
      lead_id: lead.id,
      wa_message_id: `old.${i}`,
      direction: 'outbound_bot',
      body: `viejo ${i}`,
      raw: {},
      created_at: ago(48 * 3_600_000),
    });
  }

  const result = await drainQueue();
  assert.equal(result.sent, 1);
});

test('a queue row whose lead vanished is marked failed, not retried forever', async () => {
  await store.enqueue({
    lead_id: 'does-not-exist',
    body: 'huérfano',
    send_after: ago(1_000),
  });

  const result = await drainQueue();

  assert.equal(result.failed, 1);
  assert.equal(store.queue[0]!.attempts, 1);
});
