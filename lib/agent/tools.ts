import type { ToolDefinition } from '../ai/types.js';
import type { Lead } from '../store/types.js';

/**
 * Tool registry.
 *
 * M4 ships the contract and no tools, so the agent runs as a pure conversation.
 * M5 fills this in with the six real tools from SPEC §6.
 */

export interface ToolOutcome {
  result: unknown;
  isError?: boolean;
  /** Set when the tool ended the bot's turn, e.g. an escalation. */
  stopConversation?: boolean;
  /** What to say to the parent instead of the model's own text. */
  replyOverride?: string;
}

export function getToolDefinitions(): ToolDefinition[] {
  return [];
}

export async function executeTool(
  _lead: Lead,
  name: string,
  _input: Record<string, unknown>,
): Promise<ToolOutcome> {
  return {
    result: `Unknown tool: ${name}. No tools are available in this build.`,
    isError: true,
  };
}
