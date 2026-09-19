import { getProvider, isRealProvider } from '../ai/index.js';
import { overCostCeiling } from '../ai/pricing.js';
import type { AiMessage, AiResponse } from '../ai/types.js';
import { config } from '../config.js';
import { getBotState } from '../killswitch.js';
import { log } from '../logger.js';
import { getStore } from '../store/index.js';
import type { Lead } from '../store/types.js';
import { markAsRead } from '../whatsapp.js';
import { escalateToHuman } from './escalate.js';
import { buildHistory, splitHistory, summariseOlder } from './history.js';
import { scheduleBurst, splitReply } from './pacing.js';
import { buildSystemPrompt, detectMandatoryEscalation } from './prompt.js';

/**
 * One inbound message in, at most two queued replies out.
 *
 * Nothing here sends anything directly. Replies go into `outbound_queue` with a
 * send time and the drain does the sending, re-checking the world as it goes.
 */

export interface AgentRunResult {
  status:
    | 'queued'
    | 'skipped_paused'
    | 'skipped_kill_switch'
    | 'escalated'
    | 'no_reply'
    | 'error';
  queued: number;
  detail?: string;
}

/** Tool loop ceiling — a model that cannot finish in this many rounds escalates. */
const MAX_TOOL_ROUNDS = 5;

export async function runAgent(
  leadId: string,
  inbound: { text: string; waMessageId: string },
): Promise<AgentRunResult> {
  const store = await getStore();
  const lead = await store.getLeadById(leadId);
  if (!lead) return { status: 'error', queued: 0, detail: 'lead not found' };

  // SPEC rule 2: the bot never fights the human.
  if (lead.bot_paused) {
    log.info('agent.skipped_paused', { lead_id: lead.id, reason: lead.bot_paused_reason });
    return { status: 'skipped_paused', queued: 0, detail: lead.bot_paused_reason ?? undefined };
  }

  const botState = await getBotState();
  if (!botState.enabled) {
    log.warn('agent.skipped_kill_switch', {
      lead_id: lead.id,
      blockedBy: botState.blockedBy,
      human: 'A message arrived while the bot was switched off. It was recorded but not answered.',
    });
    return { status: 'skipped_kill_switch', queued: 0, detail: botState.blockedBy ?? undefined };
  }

  // SPEC §6: a keyword pre-check in code, because these are the conversations
  // where a model getting it wrong costs a customer or hurts a child.
  const forced = detectMandatoryEscalation(inbound.text);
  if (forced) {
    const escalation = await escalateToHuman(
      lead,
      forced,
      `Mensaje del padre/madre: "${truncate(inbound.text, 300)}"`,
    );
    if (escalation.ack) await queueReplies(lead, [escalation.ack]);
    return { status: 'escalated', queued: escalation.ack ? 1 : 0, detail: forced };
  }

  // SPEC §9: a runaway conversation escalates instead of billing forever.
  if (overCostCeiling(lead.cost_usd)) {
    await escalateToHuman(
      lead,
      'cost_ceiling',
      `Esta conversación ya costó USD ${lead.cost_usd.toFixed(3)} en tokens y se pausó automáticamente.`,
    );
    return { status: 'escalated', queued: 0, detail: 'cost_ceiling' };
  }

  await markAsRead(inbound.waMessageId, true).catch(() => {
    // Cosmetic. Never let a read receipt stop a reply.
  });

  let response: AiResponse;
  try {
    response = await think(lead);
  } catch (err) {
    log.error('agent.model_failed', {
      lead_id: lead.id,
      error: String(err),
      human: 'The AI service failed to answer. The conversation was handed to Jordi.',
    });
    await escalateToHuman(
      lead,
      'ai_unavailable',
      'El asistente no pudo generar una respuesta (fallo del proveedor de IA).',
    );
    return { status: 'error', queued: 0, detail: String(err) };
  }

  const replies = splitReply(response.text);
  if (replies.length === 0) {
    log.warn('agent.empty_reply', { lead_id: lead.id, stopReason: response.stopReason });
    return { status: 'no_reply', queued: 0 };
  }

  const queued = await queueReplies(lead, replies);
  return { status: 'queued', queued };
}

/**
 * Runs the model, resolving tool calls until it produces a final answer.
 *
 * M4 registers no tools, so this settles in one round. M5 adds the six real
 * tools and the loop starts earning its keep.
 */
async function think(lead: Lead): Promise<AiResponse> {
  const store = await getStore();
  const provider = getProvider();

  const all = await store.listMessages(lead.id, 200);
  const { recent, older } = splitHistory(all);

  const system = buildSystemPrompt(lead, summariseOlder(lead, older));
  const messages: AiMessage[] = buildHistory(recent);

  // A provider needs at least one turn to answer.
  if (messages.length === 0 || messages[0]!.role !== 'user') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: 'hola' }] });
  }

  const { getToolDefinitions, executeTool } = await import('./tools.js');
  const tools = getToolDefinitions();

  let totalCost = 0;
  let response: AiResponse | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    response = await provider.complete({
      system,
      messages,
      tools,
      maxTokens: config.ai.maxTokens,
    });

    totalCost += response.usage.costUsd;
    log.info('agent.model_call', {
      lead_id: lead.id,
      provider: provider.name,
      real: isRealProvider(),
      round,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd: Number(response.usage.costUsd.toFixed(5)),
      toolCalls: response.toolCalls.map((c) => c.name),
    });

    if (response.toolCalls.length === 0) break;

    messages.push({
      role: 'assistant',
      content: [
        ...(response.text ? [{ type: 'text' as const, text: response.text }] : []),
        ...response.toolCalls.map((call) => ({
          type: 'tool_call' as const,
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      ],
    });

    const results = [];
    for (const call of response.toolCalls) {
      const outcome = await executeTool(lead, call.name, call.input);
      results.push({
        type: 'tool_result' as const,
        id: call.id,
        name: call.name,
        result: outcome.result,
        isError: outcome.isError,
      });
      if (outcome.stopConversation) {
        // A tool paused the conversation (escalation). Whatever the model would
        // say next is no longer ours to send.
        await recordCost(lead, totalCost);
        return { ...response, text: outcome.replyOverride ?? '', toolCalls: [] };
      }
    }

    messages.push({ role: 'user', content: results });
  }

  await recordCost(lead, totalCost);

  if (!response) throw new Error('no response from provider');
  return response;
}

async function recordCost(lead: Lead, added: number): Promise<void> {
  if (added <= 0) return;
  const store = await getStore();
  await store.updateLead(lead.id, { cost_usd: Number((lead.cost_usd + added).toFixed(6)) });
}

async function queueReplies(lead: Lead, replies: string[]): Promise<number> {
  const store = await getStore();
  const burst = scheduleBurst(replies);

  for (const item of burst) {
    await store.enqueue({ lead_id: lead.id, body: item.body, send_after: item.sendAfter });
  }

  log.info('agent.replies_queued', {
    lead_id: lead.id,
    count: burst.length,
    firstSendAfter: burst[0]?.sendAfter,
  });

  return burst.length;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
