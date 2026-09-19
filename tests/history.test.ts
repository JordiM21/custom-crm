import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHistory, HISTORY_LIMIT, splitHistory, summariseOlder } from '../lib/agent/history.js';
import { messageText } from '../lib/ai/types.js';
import type { Lead, Message } from '../lib/store/types.js';

let seq = 0;
function msg(direction: Message['direction'], body: string | null): Message {
  seq += 1;
  return {
    id: `m${seq}`,
    lead_id: 'lead',
    wa_message_id: `wamid.${seq}`,
    direction,
    body,
    raw: {},
    created_at: new Date(Date.now() - (1000 - seq) * 1000).toISOString(),
  };
}

const lead: Lead = {
  id: 'lead',
  wa_id: '573001112233',
  profile_name: 'Marcela R.',
  display_name: 'Marcela',
  student_name: 'Sofía',
  student_age: 9,
  stage: 'engaged',
  tags: [],
  ctwa_clid: null,
  ctwa_source_id: null,
  ctwa_headline: null,
  ctwa_captured_at: null,
  bot_paused: false,
  bot_paused_reason: null,
  bot_paused_at: null,
  first_contact_at: '2026-01-05T10:00:00.000Z',
  last_message_at: null,
  last_inbound_at: null,
  notes: null,
  cost_usd: 0,
  created_at: '2026-01-05T10:00:00.000Z',
  updated_at: '2026-01-05T10:00:00.000Z',
};

test('inbound messages become user turns and bot messages assistant turns', () => {
  const turns = buildHistory([msg('inbound', 'hola'), msg('outbound_bot', 'hola! qué edad tiene?')]);

  assert.equal(turns.length, 2);
  assert.equal(turns[0]!.role, 'user');
  assert.equal(turns[1]!.role, 'assistant');
});

test("Jordi's own replies are included as assistant turns", () => {
  const turns = buildHistory([
    msg('inbound', 'hola'),
    msg('outbound_human', 'Hola, soy Jordi, te paso el link'),
  ]);

  assert.equal(turns[1]!.role, 'assistant');
  assert.match(messageText(turns[1]!), /soy Jordi/);
});

test('consecutive messages from the same side are merged into one turn', () => {
  const turns = buildHistory([
    msg('inbound', 'hola'),
    msg('inbound', 'tengo una pregunta'),
    msg('inbound', 'sobre los horarios'),
    msg('outbound_bot', 'claro, dime'),
  ]);

  assert.equal(turns.length, 2, 'three parent messages collapse to one turn');
  assert.match(messageText(turns[0]!), /hola\ntengo una pregunta\nsobre los horarios/);
});

test('messages with no text body are skipped', () => {
  const turns = buildHistory([msg('inbound', null), msg('inbound', '  '), msg('inbound', 'hola')]);

  assert.equal(turns.length, 1);
  assert.equal(messageText(turns[0]!), 'hola');
});

test('a short conversation is passed through whole', () => {
  const messages = Array.from({ length: 5 }, () => msg('inbound', 'hola'));
  const { recent, older } = splitHistory(messages);

  assert.equal(recent.length, 5);
  assert.equal(older.length, 0);
});

test('a long conversation keeps the most recent turns', () => {
  const messages = Array.from({ length: 45 }, (_, i) => msg('inbound', `mensaje ${i}`));
  const { recent, older } = splitHistory(messages);

  assert.equal(recent.length, HISTORY_LIMIT);
  assert.equal(older.length, 45 - HISTORY_LIMIT);
  assert.equal(recent.at(-1)!.body, 'mensaje 44');
});

test('the overflow is summarised rather than silently dropped', () => {
  const older = Array.from({ length: 12 }, () => msg('inbound', 'hola'));
  const summary = summariseOlder(lead, older);

  assert.ok(summary);
  assert.match(summary!, /12 mensajes anteriores/);
  assert.match(summary!, /Sofía/);
  assert.match(summary!, /9 años/);
  assert.match(summary!, /No vuelvas a preguntar/);
});

test('nothing is summarised when nothing overflowed', () => {
  assert.equal(summariseOlder(lead, []), undefined);
});

test("the summary mentions messages Jordi wrote himself", () => {
  const older = [msg('inbound', 'hola'), msg('outbound_human', 'te escribo yo')];
  const summary = summariseOlder(lead, older);

  assert.match(summary!, /escritos por Jordi en persona/);
});
