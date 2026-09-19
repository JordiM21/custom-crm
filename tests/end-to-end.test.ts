import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { __setKnowledge } from '../lib/agent/knowledge.js';
import { __setProvider } from '../lib/ai/index.js';
import type { AiProvider, AiRequest, AiResponse } from '../lib/ai/types.js';
import { setBotEnabled } from '../lib/killswitch.js';
import type { WebhookPayload } from '../lib/meta/types.js';
import { drainQueue } from '../lib/queue.js';
import { MemoryStore } from '../lib/store/memory.js';
import { __setStore } from '../lib/store/index.js';
import { processPayload } from '../lib/webhook/process.js';

/**
 * The whole path a real message takes: webhook in, lead created, model asked,
 * reply queued, reply sent (dry run), transcript complete.
 */

/**
 * Loads a fixture and stamps it with the current time.
 *
 * Fixtures carry a fixed timestamp, which WhatsApp's 24-hour reply window would
 * treat as long expired. These tests are about the flow, not the window, which
 * has its own tests in queue.test.ts.
 */
function fixture(name: string): WebhookPayload {
  const payload = JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as WebhookPayload;

  const now = String(Math.floor(Date.now() / 1000));
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const message of change.value.messages ?? []) message.timestamp = now;
      for (const echo of change.value.message_echoes ?? []) echo.timestamp = now;
      for (const echo of change.value.smb_message_echoes ?? []) echo.timestamp = now;
    }
  }
  return payload;
}

class ScriptedProvider implements AiProvider {
  readonly name = 'scripted';
  calls = 0;
  lastRequest: AiRequest | null = null;

  constructor(private readonly replies: string[]) {}

  isConfigured(): boolean {
    return true;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    this.lastRequest = request;
    const text = this.replies[Math.min(this.calls, this.replies.length - 1)] ?? 'ok';
    this.calls += 1;
    return {
      text,
      toolCalls: [],
      usage: { inputTokens: 50, outputTokens: 15, costUsd: 0.0005 },
      stopReason: 'end_turn',
    };
  }
}

let store: MemoryStore;

/** Makes every queued reply due now, instead of waiting out the pacing delay. */
function fastForwardQueue(): void {
  const past = new Date(Date.now() - 1_000).toISOString();
  for (const row of store.queue) row.send_after = past;
}

beforeEach(async () => {
  store = new MemoryStore();
  __setStore(store);
  __setKnowledge({ text: 'Plan Completo: USD 50 al mes.', unfilled: [] });
  await setBotEnabled(true);
});

test('a parent writes and gets exactly one answer', async () => {
  const provider = new ScriptedProvider(['hola! cuántos años tiene tu hija o hijo?']);
  __setProvider(provider);

  await processPayload(fixture('text-message'));

  assert.equal(provider.calls, 1, 'the model was asked once');
  assert.equal(await store.pendingQueueCount(), 1, 'one reply queued, not sent instantly');

  fastForwardQueue();
  const drained = await drainQueue();
  assert.equal(drained.sent, 1);

  const transcript = await store.listMessages(store.leads[0]!.id);
  assert.deepEqual(
    transcript.map((m) => m.direction),
    ['inbound', 'outbound_bot'],
  );
  assert.equal(transcript[1]!.body, 'hola! cuántos años tiene tu hija o hijo?');
});

test('Meta re-delivering the same message does not produce a second answer', async () => {
  const provider = new ScriptedProvider(['hola! cuántos años tiene?']);
  __setProvider(provider);

  await processPayload(fixture('text-message'));
  await processPayload(fixture('text-message'));
  await processPayload(fixture('text-message'));

  assert.equal(provider.calls, 1, 'the model was asked once despite three deliveries');
  assert.equal(await store.pendingQueueCount(), 1);
});

test('a reply Jordi sends mid-delay wins over the queued bot message', async () => {
  __setProvider(new ScriptedProvider(['hola! cuántos años tiene?']));

  await processPayload(fixture('text-message'));
  assert.equal(await store.pendingQueueCount(), 1);

  // Jordi answers from his phone before the queued message went out.
  await processPayload(fixture('echo-smb'));

  // The echo cancels the queued reply immediately, so by the time the queue is
  // drained there is nothing left to send.
  assert.equal(await store.pendingQueueCount(), 0);
  assert.ok(store.queue.every((q) => q.cancelled_at !== null));

  fastForwardQueue();
  const drained = await drainQueue();
  assert.equal(drained.sent, 0);

  const transcript = await store.listMessages(store.leads[0]!.id);
  assert.equal(
    transcript.filter((m) => m.direction === 'outbound_bot').length,
    0,
    'the bot never talked over Jordi',
  );
});

test('a photo is acknowledged, escalated, and never guessed at', async () => {
  const provider = new ScriptedProvider(['no debería opinar sobre una foto']);
  __setProvider(provider);

  await processPayload(fixture('image-message'));

  assert.equal(provider.calls, 0, 'the model was never shown the image');

  const lead = store.leads[0]!;
  assert.equal(lead.bot_paused, true);
  assert.equal(lead.bot_paused_reason, 'escalated:unsupported_media');
});

test('an ad click is captured before the agent runs, so the first reply knows the ad', async () => {
  const provider = new ScriptedProvider(['hola! qué edad tiene?']);
  __setProvider(provider);

  await processPayload(fixture('ctwa-referral'));

  assert.equal(store.leads[0]!.ctwa_clid, 'CTWA_CLID_TEST_ABC123');
  assert.match(provider.lastRequest!.system, /Aprende ingles jugando/);
});

test('with the bot switched off the message is stored and left unanswered', async () => {
  const provider = new ScriptedProvider(['hola!']);
  __setProvider(provider);
  await setBotEnabled(false);

  await processPayload(fixture('text-message'));

  assert.equal(provider.calls, 0);
  assert.equal(await store.pendingQueueCount(), 0);
  assert.equal(store.messages.length, 1, 'the parent’s message was still recorded');
});
