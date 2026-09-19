/**
 * A provider-neutral shape for a chat completion with tool use.
 *
 * No AI vendor has been chosen yet, so nothing above this layer may know which
 * one is in use. Adding a vendor means writing one adapter that translates
 * these types to and from its wire format — no other file changes.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; name: string; result: unknown; isError?: boolean };

export interface AiMessage {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments. */
  parameters: Record<string, unknown>;
}

export interface AiRequest {
  system: string;
  messages: AiMessage[];
  tools: ToolDefinition[];
  maxTokens: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** Estimated. Accurate only if the price env vars match the provider's rates. */
  costUsd: number;
}

export interface AiResponse {
  /** Everything the model wants to say, already joined. */
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  usage: AiUsage;
  stopReason: string;
}

export interface AiProvider {
  readonly name: string;
  /** False when credentials are missing — the caller escalates instead of guessing. */
  isConfigured(): boolean;
  complete(request: AiRequest): Promise<AiResponse>;
}

export function textBlock(text: string): ContentBlock {
  return { type: 'text', text };
}

export function userText(text: string): AiMessage {
  return { role: 'user', content: [textBlock(text)] };
}

export function assistantText(text: string): AiMessage {
  return { role: 'assistant', content: [textBlock(text)] };
}

/** Joins the text blocks of a message, ignoring tool traffic. */
export function messageText(message: AiMessage): string {
  return message.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
