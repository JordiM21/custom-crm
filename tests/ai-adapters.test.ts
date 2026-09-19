import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { AiRequest } from '../lib/ai/types.js';

// lib/config.ts reads the environment once, at import time — which is right for
// a serverless process but means these must be set before the adapters load.
// Static imports are hoisted above this, so the adapters come in dynamically.
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
process.env['AI_API_KEY'] = 'test-key';
process.env['AI_MODEL'] = 'test-model';

const { AnthropicProvider } = await import('../lib/ai/anthropic.js');
const { OpenAiCompatibleProvider } = await import('../lib/ai/openai-compatible.js');

/**
 * These verify the translation between our provider-neutral shapes and each
 * vendor's wire format, with `fetch` stubbed. They cannot prove the remote API
 * accepts the body — only a live call does that — but they do catch the
 * failure mode that actually bites: a field renamed on one side of the adapter
 * and not the other.
 */

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let captured: Captured | null = null;

function stubFetch(response: unknown, ok = true, status = 200): void {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = {
      url: String(url),
      headers: (init.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    };
    return {
      ok,
      status,
      json: async () => response,
    } as Response;
  }) as typeof fetch;
}

const REQUEST: AiRequest = {
  system: 'Eres parte del equipo de LET Junior.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'hola, tiene 9 años' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'un momento' },
        { type: 'tool_call', id: 'call_1', name: 'update_lead', input: { student_age: 9 } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', id: 'call_1', name: 'update_lead', result: { ok: true } },
      ],
    },
  ],
  tools: [
    {
      name: 'update_lead',
      description: 'Guarda lo que aprendiste del contacto.',
      parameters: { type: 'object', properties: { student_age: { type: 'number' } } },
    },
  ],
  maxTokens: 600,
};

beforeEach(() => {
  captured = null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// --- Anthropic ---------------------------------------------------------------

test('anthropic: posts to the Messages API with the required headers', async () => {
  stubFetch({ content: [{ type: 'text', text: 'listo' }], usage: {} });
  await new AnthropicProvider().complete(REQUEST);

  assert.equal(captured!.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(captured!.headers['x-api-key'], 'sk-ant-test');
  assert.equal(captured!.headers['anthropic-version'], '2023-06-01');
});

test('anthropic: system prompt is a top-level field, not a message', async () => {
  stubFetch({ content: [{ type: 'text', text: 'ok' }], usage: {} });
  await new AnthropicProvider().complete(REQUEST);

  assert.equal(captured!.body['system'], REQUEST.system);
  const messages = captured!.body['messages'] as { role: string }[];
  assert.ok(
    messages.every((m) => m.role !== 'system'),
    'no system role inside messages',
  );
});

test('anthropic: tools use input_schema, its name for a JSON schema', async () => {
  stubFetch({ content: [], usage: {} });
  await new AnthropicProvider().complete(REQUEST);

  const tools = captured!.body['tools'] as Record<string, unknown>[];
  assert.equal(tools[0]!['name'], 'update_lead');
  assert.deepEqual(tools[0]!['input_schema'], REQUEST.tools[0]!.parameters);
  assert.equal(tools[0]!['parameters'], undefined, 'not the OpenAI spelling');
});

test('anthropic: tool calls and results map to tool_use and tool_result', async () => {
  stubFetch({ content: [], usage: {} });
  await new AnthropicProvider().complete(REQUEST);

  const messages = captured!.body['messages'] as { content: Record<string, unknown>[] }[];

  const toolUse = messages[1]!.content.find((b) => b['type'] === 'tool_use');
  assert.ok(toolUse, 'assistant tool call sent as tool_use');
  assert.equal(toolUse!['id'], 'call_1');

  const toolResult = messages[2]!.content.find((b) => b['type'] === 'tool_result');
  assert.ok(toolResult, 'result sent as tool_result');
  assert.equal(toolResult!['tool_use_id'], 'call_1', 'linked by tool_use_id');
});

test('anthropic: reads text, tool calls and token usage off the response', async () => {
  stubFetch({
    content: [
      { type: 'text', text: 'perfecto, a los 9 avanzan rápido' },
      { type: 'tool_use', id: 'call_9', name: 'update_lead', input: { student_age: 9 } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 1200, output_tokens: 40 },
  });

  const result = await new AnthropicProvider().complete(REQUEST);

  assert.match(result.text, /a los 9 avanzan/);
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]!.name, 'update_lead');
  assert.deepEqual(result.toolCalls[0]!.input, { student_age: 9 });
  assert.equal(result.usage.inputTokens, 1200);
  assert.equal(result.usage.outputTokens, 40);
  assert.equal(result.stopReason, 'tool_use');
});

test('anthropic: cost is estimated at Haiku 4.5 rates by default', async () => {
  stubFetch({
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
  });

  const result = await new AnthropicProvider().complete(REQUEST);

  // USD 1 per million in, USD 5 per million out.
  assert.equal(Number(result.usage.costUsd.toFixed(2)), 6);
});

test('anthropic: an API error surfaces the message, not a silent empty reply', async () => {
  stubFetch({ error: { message: 'invalid x-api-key' } }, false, 401);

  await assert.rejects(
    () => new AnthropicProvider().complete(REQUEST),
    /401.*invalid x-api-key/,
  );
});

test('anthropic: reports configured once a key is present', () => {
  assert.equal(new AnthropicProvider().isConfigured(), true);
});

// --- OpenAI-compatible -------------------------------------------------------

test('openai-compatible: posts to /chat/completions with a bearer token', async () => {
  stubFetch({ choices: [{ message: { content: 'ok' } }], usage: {} });
  await new OpenAiCompatibleProvider().complete(REQUEST);

  assert.ok(captured!.url.endsWith('/chat/completions'));
  assert.equal(captured!.headers['authorization'], 'Bearer test-key');
});

test('openai-compatible: the system prompt becomes the first message', async () => {
  stubFetch({ choices: [{ message: { content: 'ok' } }], usage: {} });
  await new OpenAiCompatibleProvider().complete(REQUEST);

  const messages = captured!.body['messages'] as { role: string; content: string }[];
  assert.equal(messages[0]!.role, 'system');
  assert.equal(messages[0]!.content, REQUEST.system);
});

test('openai-compatible: tool results become their own role', async () => {
  stubFetch({ choices: [{ message: { content: 'ok' } }], usage: {} });
  await new OpenAiCompatibleProvider().complete(REQUEST);

  const messages = captured!.body['messages'] as Record<string, unknown>[];
  const toolMessage = messages.find((m) => m['role'] === 'tool');
  assert.ok(toolMessage, 'result sent as a tool-role message');
  assert.equal(toolMessage!['tool_call_id'], 'call_1');
});

test('openai-compatible: tools are wrapped as functions', async () => {
  stubFetch({ choices: [{ message: { content: 'ok' } }], usage: {} });
  await new OpenAiCompatibleProvider().complete(REQUEST);

  const tools = captured!.body['tools'] as Record<string, Record<string, unknown>>[];
  assert.equal(tools[0]!['type'], 'function');
  assert.equal(tools[0]!['function']!['name'], 'update_lead');
});

test('openai-compatible: tool call arguments are parsed from their JSON string', async () => {
  stubFetch({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id: 'c1', function: { name: 'update_lead', arguments: '{"student_age":11}' } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  });

  const result = await new OpenAiCompatibleProvider().complete(REQUEST);

  assert.deepEqual(result.toolCalls[0]!.input, { student_age: 11 });
});

test('openai-compatible: unparseable tool arguments degrade instead of throwing', async () => {
  stubFetch({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id: 'c1', function: { name: 'update_lead', arguments: '{broken' } }],
        },
      },
    ],
    usage: {},
  });

  const result = await new OpenAiCompatibleProvider().complete(REQUEST);

  // The tool's own validation then returns a usable error to the model.
  assert.deepEqual(result.toolCalls[0]!.input, {});
});
