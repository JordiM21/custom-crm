import { config } from '../config.js';
import { estimateCostUsd } from './pricing.js';
import type { AiMessage, AiProvider, AiRequest, AiResponse, ContentBlock } from './types.js';

/**
 * Anthropic Messages API adapter. Plain fetch, no SDK — one less dependency to
 * keep current, and it keeps the provider layer symmetric.
 */

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

function toAnthropicContent(content: ContentBlock[]): unknown[] {
  return content.map((block) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text };
      case 'tool_call':
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: typeof block.result === 'string' ? block.result : JSON.stringify(block.result),
          ...(block.isError ? { is_error: true } : {}),
        };
    }
  });
}

function toAnthropicMessages(messages: AiMessage[]): unknown[] {
  return messages.map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';

  isConfigured(): boolean {
    return Boolean(config.ai.anthropicKey);
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const model = config.ai.anthropicModel;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ai.anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: request.maxTokens,
        system: request.system,
        messages: toAnthropicMessages(request.messages),
        ...(request.tools.length
          ? {
              tools: request.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      }),
    });

    const body = (await response.json()) as AnthropicResponse;

    if (!response.ok) {
      throw new Error(
        `anthropic ${response.status}: ${body.error?.message ?? 'unexpected error'}`,
      );
    }

    const text = (body.content ?? [])
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text as string)
      .join('\n')
      .trim();

    const toolCalls = (body.content ?? [])
      .filter((b) => b.type === 'tool_use' && b.id && b.name)
      .map((b) => ({ id: b.id as string, name: b.name as string, input: b.input ?? {} }));

    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;

    return {
      text,
      toolCalls,
      usage: { inputTokens, outputTokens, costUsd: estimateCostUsd(inputTokens, outputTokens) },
      stopReason: body.stop_reason ?? 'end_turn',
    };
  }
}
