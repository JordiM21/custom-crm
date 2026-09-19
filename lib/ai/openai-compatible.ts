import { config } from '../config.js';
import { estimateCostUsd } from './pricing.js';
import type { AiMessage, AiProvider, AiRequest, AiResponse } from './types.js';

/**
 * Adapter for anything that speaks the OpenAI chat-completions shape: OpenAI
 * itself, Groq, Together, OpenRouter, Mistral, Fireworks, DeepSeek, vLLM and
 * most self-hosted servers.
 *
 * Point AI_BASE_URL at the provider and set AI_MODEL. One env var switch, no
 * code change — which is the point of this layer while no vendor is chosen.
 */

interface OpenAiToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: OpenAiToolCall[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

/** Flattens our blocks into the message list OpenAI expects. */
function toOpenAiMessages(system: string, messages: AiMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];

  for (const message of messages) {
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
      .trim();

    const calls = message.content.filter((b) => b.type === 'tool_call');
    const results = message.content.filter((b) => b.type === 'tool_result');

    if (message.role === 'assistant' && calls.length) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((b) => {
          const call = b as { id: string; name: string; input: Record<string, unknown> };
          return {
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          };
        }),
      });
      continue;
    }

    if (results.length) {
      // Tool results are their own role in this API, one message per result.
      for (const b of results) {
        const r = b as { id: string; result: unknown };
        out.push({
          role: 'tool',
          tool_call_id: r.id,
          content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result),
        });
      }
      if (text) out.push({ role: message.role, content: text });
      continue;
    }

    if (text) out.push({ role: message.role, content: text });
  }

  return out;
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible';

  isConfigured(): boolean {
    return Boolean(config.ai.apiKey && config.ai.model && config.ai.baseUrl);
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const url = `${config.ai.baseUrl.replace(/\/$/, '')}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.ai.apiKey}`,
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: request.maxTokens,
        messages: toOpenAiMessages(request.system, request.messages),
        ...(request.tools.length
          ? {
              tools: request.tools.map((t) => ({
                type: 'function',
                function: {
                  name: t.name,
                  description: t.description,
                  parameters: t.parameters,
                },
              })),
            }
          : {}),
      }),
    });

    const body = (await response.json()) as OpenAiResponse;

    if (!response.ok) {
      throw new Error(`ai ${response.status}: ${body.error?.message ?? 'unexpected error'}`);
    }

    const choice = body.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls ?? [])
      .filter((c) => c.function?.name)
      .map((c, i) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(c.function?.arguments ?? '{}') as Record<string, unknown>;
        } catch {
          // A model that emits unparseable arguments gets an empty object; the
          // tool's own validation then returns a usable error to the model.
        }
        return { id: c.id ?? `call_${i}`, name: c.function!.name as string, input };
      });

    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;

    return {
      text: (choice?.message?.content ?? '').trim(),
      toolCalls,
      usage: { inputTokens, outputTokens, costUsd: estimateCostUsd(inputTokens, outputTokens) },
      stopReason: choice?.finish_reason ?? 'stop',
    };
  }
}
