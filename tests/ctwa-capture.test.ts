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

test('a CTWA ad click stores the click id, ad id and headline', async () => {
  await processPayload(fixture('ctwa-referral'));

  const lead = store.leads[0]!;
  assert.equal(lead.ctwa_clid, 'CTWA_CLID_TEST_ABC123');
  assert.equal(lead.ctwa_source_id, '120209876543212');
  assert.equal(lead.ctwa_headline, 'Aprende ingles jugando — clases en vivo para ninos');
  assert.ok(lead.ctwa_captured_at, 'capture time recorded');
  assert.ok(lead.tags.includes('ctwa'), 'tagged as ad traffic');
});

test('the WhatsApp profile name is captured on first contact', async () => {
  await processPayload(fixture('ctwa-referral'));
  assert.equal(store.leads[0]!.profile_name, 'Carlos M.');
});

test('a later message without a referral does not erase the click id', async () => {
  await processPayload(fixture('ctwa-referral'));

  const followUp = fixture('ctwa-referral');
  const msg = followUp.entry![0]!.changes![0]!.value.messages![0]!;
  msg.id = 'wamid.TEST.ctwa.0002';
  delete msg.referral;
  await processPayload(followUp);

  assert.equal(store.leads.length, 1);
  assert.equal(store.leads[0]!.ctwa_clid, 'CTWA_CLID_TEST_ABC123');
});

test('a second ad click does not overwrite the original attribution', async () => {
  await processPayload(fixture('ctwa-referral'));

  const secondAd = fixture('ctwa-referral');
  const msg = secondAd.entry![0]!.changes![0]!.value.messages![0]!;
  msg.id = 'wamid.TEST.ctwa.0003';
  msg.referral!.ctwa_clid = 'CTWA_CLID_DIFFERENT';
  msg.referral!.source_id = '999999999999999';
  await processPayload(secondAd);

  assert.equal(store.leads[0]!.ctwa_clid, 'CTWA_CLID_TEST_ABC123');
  assert.equal(store.leads[0]!.ctwa_source_id, '120209876543212');
});

test('a replayed CTWA payload leaves exactly one lead and one message', async () => {
  await processPayload(fixture('ctwa-referral'));
  await processPayload(fixture('ctwa-referral'));

  assert.equal(store.leads.length, 1);
  assert.equal(store.messages.length, 1);
  assert.equal(store.leads[0]!.ctwa_clid, 'CTWA_CLID_TEST_ABC123');
});

test('an organic lead has no click id and is not tagged as ad traffic', async () => {
  await processPayload(fixture('text-message'));

  const lead = store.leads[0]!;
  assert.equal(lead.ctwa_clid, null);
  assert.equal(lead.tags.includes('ctwa'), false);
});

test('the ad headline is kept so the first reply can reference the offer', async () => {
  await processPayload(fixture('ctwa-referral'));
  assert.match(store.leads[0]!.ctwa_headline ?? '', /Aprende ingles/);
});
