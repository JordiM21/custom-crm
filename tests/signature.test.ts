import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signPayload, verifyMetaSignature } from '../lib/meta/signature.js';

const SECRET = 'test_app_secret_do_not_use';
const BODY = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));

test('accepts a correctly signed payload', () => {
  const header = signPayload(BODY, SECRET);
  assert.deepEqual(verifyMetaSignature(BODY, header, SECRET), { ok: true });
});

test('rejects a payload signed with the wrong secret', () => {
  const header = signPayload(BODY, 'wrong_secret');
  const result = verifyMetaSignature(BODY, header, SECRET);
  assert.equal(result.ok, false);
});

test('rejects a payload whose body changed after signing', () => {
  const header = signPayload(BODY, SECRET);
  const tampered = Buffer.from(JSON.stringify({ object: 'evil', entry: [] }));
  const result = verifyMetaSignature(tampered, header, SECRET);
  assert.equal(result.ok, false);
});

test('rejects when the signature header is missing', () => {
  const result = verifyMetaSignature(BODY, undefined, SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'missing_signature_header');
});

test('rejects a header with the wrong scheme', () => {
  const result = verifyMetaSignature(BODY, 'sha1=abc123', SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'malformed_signature_header');
});

test('rejects everything when no app secret is configured', () => {
  const header = signPayload(BODY, SECRET);
  const result = verifyMetaSignature(BODY, header, '');
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'app_secret_not_configured');
});

test('a truncated signature does not throw', () => {
  const result = verifyMetaSignature(BODY, 'sha256=abc', SECRET);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'signature_mismatch');
});

test('byte-for-byte signing: whitespace changes invalidate the signature', () => {
  const compact = Buffer.from('{"a":1}');
  const spaced = Buffer.from('{"a": 1}');
  const header = signPayload(compact, SECRET);
  assert.equal(verifyMetaSignature(spaced, header, SECRET).ok, false);
});
