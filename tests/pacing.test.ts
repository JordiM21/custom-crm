import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeDelayMs,
  interMessageGapMs,
  MAX_DELAY_MS,
  MAX_MESSAGES_PER_INBOUND,
  MIN_DELAY_MS,
  scheduleBurst,
  splitReply,
} from '../lib/agent/pacing.js';

test('a very short reply still waits the minimum delay', () => {
  assert.equal(computeDelayMs(5), MIN_DELAY_MS);
});

test('a very long reply is capped at the maximum delay', () => {
  assert.equal(computeDelayMs(10_000), MAX_DELAY_MS);
});

test('delay grows with reply length inside the clamp', () => {
  const short = computeDelayMs(300);
  const long = computeDelayMs(900);
  assert.ok(short > MIN_DELAY_MS && short < MAX_DELAY_MS);
  assert.ok(long > short);
});

test('the gap between burst messages stays between 2 and 5 seconds', () => {
  for (let i = 0; i < 50; i += 1) {
    const gap = interMessageGapMs();
    assert.ok(gap >= 2_000 && gap < 5_000, `gap ${gap} out of range`);
  }
});

test('a single-paragraph reply stays one message', () => {
  assert.deepEqual(splitReply('hola! cuántos años tiene?'), ['hola! cuántos años tiene?']);
});

test('a reply with short line breaks is not split', () => {
  const text = 'hola!\nqué tal?';
  assert.deepEqual(splitReply(text), [text]);
});

test('a reply is split on blank lines', () => {
  const result = splitReply('primera parte\n\nsegunda parte');
  assert.deepEqual(result, ['primera parte', 'segunda parte']);
});

test('never more than two messages per inbound message', () => {
  const result = splitReply('uno\n\ndos\n\ntres\n\ncuatro');
  assert.equal(result.length, MAX_MESSAGES_PER_INBOUND);
  assert.deepEqual(result, ['uno', 'dos']);
});

test('an empty reply produces no messages', () => {
  assert.deepEqual(splitReply('   \n  '), []);
});

test('burst send times are ordered and start after the pacing delay', () => {
  const from = Date.now();
  const burst = scheduleBurst(['hola', 'y una cosa más'], from);

  assert.equal(burst.length, 2);
  const first = new Date(burst[0]!.sendAfter).getTime();
  const second = new Date(burst[1]!.sendAfter).getTime();

  assert.ok(first >= from + MIN_DELAY_MS, 'first message waits the pacing delay');
  assert.ok(second > first, 'second message comes after the first');
  assert.ok(second - first >= 2_000, 'at least 2s between messages');
});
