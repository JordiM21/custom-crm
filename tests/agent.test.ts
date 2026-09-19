import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { __setProvider } from '../lib/ai/index.js';
import type { AiProvider, AiRequest, AiResponse } from '../lib/ai/types.js';
import { __setKnowledge } from '../lib/agent/knowledge.js';
import { runAgent } from '../lib/agent/run.js';
import { setBotEnabled } from '../lib/killswitch.js';
import { MemoryStore } from '../lib/store/memory.js';
import { __setStore } from '../lib/store/index.js';
import type { Lead } from '../lib/store/types.js';

class FakeProvider implements AiProvider {
  readonly name = 'fake';
  lastRequest: AiRequest | null = null;
  reply = 'perfecto. qué edad tiene?';

  isConfigured(): boolean {
    return true;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    this.lastRequest = request;
    return {
      text: this.reply,
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
      stopReason: 'end_turn',
    };
  }
}

let store: MemoryStore;
let provider: FakeProvider;

async function makeLead(patch: Partial<Lead> = {}): Promise<Lead> {
  const lead = await store.upsertLead('573001112233', {
    profile_name: 'Marcela R.',
    last_inbound_at: new Date().toISOString(),
    ...patch,
  });
  await store.insertMessage({
    lead_id: lead.id,
    wa_message_id: `in.${Math.random()}`,
    direction: 'inbound',
    body: 'hola, info de las clases',
    raw: {},
  });
  return lead;
}

beforeEach(async () => {
  store = new MemoryStore();
  __setStore(store);
  provider = new FakeProvider();
  __setProvider(provider);
  // A complete knowledge file, so the "incomplete" warning is not under test.
  __setKnowledge({ text: 'Plan Completo: USD 50 al mes, 2 clases por semana.', unfilled: [] });
  await setBotEnabled(true);
});

test('a normal message produces queued replies, never a direct send', async () => {
  const lead = await makeLead();
  const result = await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.1' });

  assert.equal(result.status, 'queued');
  assert.equal(result.queued, 1);
  assert.equal(await store.pendingQueueCount(), 1);
  assert.equal(store.queue[0]!.body, provider.reply);
});

test('never more than two messages are queued for one inbound message', async () => {
  const lead = await makeLead();
  provider.reply = 'uno\n\ndos\n\ntres\n\ncuatro';

  const result = await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.2' });

  assert.equal(result.queued, 2);
  assert.equal(await store.pendingQueueCount(), 2);
});

test('a paused lead is not answered', async () => {
  const lead = await makeLead({ bot_paused: true, bot_paused_reason: 'human_replied' });

  const result = await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.3' });

  assert.equal(result.status, 'skipped_paused');
  assert.equal(await store.pendingQueueCount(), 0);
  assert.equal(provider.lastRequest, null, 'the model was never called');
});

test('the kill switch stops replies but not recording', async () => {
  const lead = await makeLead();
  await setBotEnabled(false);

  const result = await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.4' });

  assert.equal(result.status, 'skipped_kill_switch');
  assert.equal(await store.pendingQueueCount(), 0);
  assert.equal(store.messages.length, 1, 'the inbound message is still stored');
});

test('a discount request escalates without asking the model', async () => {
  const lead = await makeLead();

  const result = await runAgent(lead.id, {
    text: 'hola, tienen algun descuento por dos hermanos?',
    waMessageId: 'wamid.5',
  });

  assert.equal(result.status, 'escalated');
  assert.equal(provider.lastRequest, null, 'the model was never asked');

  const updated = (await store.getLeadById(lead.id))!;
  assert.equal(updated.bot_paused, true);
  assert.equal(updated.bot_paused_reason, 'escalated:price_negotiation');
  assert.equal(updated.stage, 'human_handling');
});

test('a message about a learning difficulty escalates', async () => {
  const lead = await makeLead();

  const result = await runAgent(lead.id, {
    text: 'mi hijo tiene dislexia, sirve igual la clase?',
    waMessageId: 'wamid.6',
  });

  assert.equal(result.status, 'escalated');
  assert.equal((await store.getLeadById(lead.id))!.bot_paused_reason, 'escalated:child_wellbeing');
});

test('a refund request escalates', async () => {
  const lead = await makeLead();
  const result = await runAgent(lead.id, {
    text: 'quiero un reembolso de lo que pagué',
    waMessageId: 'wamid.7',
  });
  assert.equal(result.status, 'escalated');
});

test('an ordinary question does not escalate', async () => {
  const lead = await makeLead();
  const result = await runAgent(lead.id, {
    text: 'hola, mi hija tiene 9 años y quiere aprender',
    waMessageId: 'wamid.8',
  });
  assert.equal(result.status, 'queued');
});

test('a lead over the cost ceiling is handed to a human', async () => {
  const lead = await makeLead({ cost_usd: 99 });

  const result = await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.9' });

  assert.equal(result.status, 'escalated');
  assert.equal(result.detail, 'cost_ceiling');
  assert.equal(provider.lastRequest, null);
});

test('token spend is accumulated on the lead', async () => {
  const lead = await makeLead();
  await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.10' });

  const updated = (await store.getLeadById(lead.id))!;
  assert.ok(updated.cost_usd > 0, 'cost recorded');
});

test('a provider failure escalates instead of leaving the parent unanswered', async () => {
  const lead = await makeLead();
  __setProvider({
    name: 'broken',
    isConfigured: () => true,
    complete: async () => {
      throw new Error('502 from provider');
    },
  });

  const result = await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.11' });

  assert.equal(result.status, 'error');
  const updated = (await store.getLeadById(lead.id))!;
  assert.equal(updated.bot_paused, true);
  assert.equal(updated.bot_paused_reason, 'escalated:ai_unavailable');
});

test('an empty model reply queues nothing', async () => {
  const lead = await makeLead();
  provider.reply = '   ';

  const result = await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.12' });

  assert.equal(result.status, 'no_reply');
  assert.equal(await store.pendingQueueCount(), 0);
});

test('the ad headline reaches the system prompt', async () => {
  const lead = await makeLead({ ctwa_headline: 'Primera clase gratis' });
  await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.13' });

  assert.match(provider.lastRequest!.system, /Primera clase gratis/);
});

test('an incomplete knowledge file adds the do-not-quote-facts warning', async () => {
  __setKnowledge({ text: 'Precio: «USD ___ al mes»', unfilled: ['«USD ___ al mes»'] });
  const lead = await makeLead();

  await runAgent(lead.id, { text: 'hola', waMessageId: 'wamid.14' });

  assert.match(provider.lastRequest!.system, /INCOMPLETA/);
});

test('the agent resolves a tool call and then answers the parent', async () => {
  const lead = await makeLead();

  let round = 0;
  __setProvider({
    name: 'tool-using',
    isConfigured: () => true,
    complete: async () => {
      round += 1;
      if (round === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'call_1',
              name: 'update_lead',
              input: { student_name: 'Sofía', student_age: 9, stage: 'qualified' },
            },
          ],
          usage: { inputTokens: 40, outputTokens: 10, costUsd: 0.0004 },
          stopReason: 'tool_use',
        };
      }
      return {
        text: 'perfecto, a los 9 avanzan rapidísimo. te agendo una clase de prueba?',
        toolCalls: [],
        usage: { inputTokens: 60, outputTokens: 20, costUsd: 0.0006 },
        stopReason: 'end_turn',
      };
    },
  });

  const result = await runAgent(lead.id, { text: 'tiene 9 años', waMessageId: 'wamid.20' });

  assert.equal(result.status, 'queued');
  assert.equal(round, 2, 'the model was called again with the tool result');

  const updated = (await store.getLeadById(lead.id))!;
  assert.equal(updated.student_name, 'Sofía');
  assert.equal(updated.stage, 'qualified');
  assert.match(store.queue[0]!.body, /clase de prueba/);
});

test('a tool that escalates stops the turn, whatever the model wanted to say next', async () => {
  const lead = await makeLead();

  __setProvider({
    name: 'escalating',
    isConfigured: () => true,
    complete: async () => ({
      text: 'el plan cuesta cien dólares',
      toolCalls: [
        {
          id: 'call_1',
          name: 'escalate_to_human',
          input: { reason: 'missing_info', summary: 'Pregunta algo que no está en la información.' },
        },
      ],
      usage: { inputTokens: 40, outputTokens: 10, costUsd: 0.0004 },
      stopReason: 'tool_use',
    }),
  });

  const result = await runAgent(lead.id, { text: 'dan certificado?', waMessageId: 'wamid.21' });

  assert.equal(result.status, 'no_reply', 'the drafted reply was discarded');
  assert.equal(store.queue.length, 0, 'the invented price never got queued');

  const sent = store.messages.filter((m) => m.direction === 'outbound_bot');
  assert.equal(sent.length, 1, 'only the escalation acknowledgement went out');
  assert.doesNotMatch(sent[0]!.body ?? '', /cien dólares/);

  const updated = (await store.getLeadById(lead.id))!;
  assert.equal(updated.bot_paused, true);
});

test('a parent who asks for a discount is answered, not left in silence', async () => {
  const lead = await makeLead();

  const result = await runAgent(lead.id, {
    text: 'hay descuento por dos hermanos?',
    waMessageId: 'wamid.22',
  });

  assert.equal(result.status, 'escalated');

  // The regression this guards: the acknowledgement used to be queued, and the
  // drain cancels queued messages for a paused lead — so the parent asked
  // about a discount and got nothing at all.
  const sent = store.messages.filter((m) => m.direction === 'outbound_bot');
  assert.equal(sent.length, 1, 'the parent was told Jordi will reply');
  assert.match(sent[0]!.body ?? '', /Jordi/);
  assert.equal(await store.pendingQueueCount(), 0, 'nothing left stuck in the queue');
});
