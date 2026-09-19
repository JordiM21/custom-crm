import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { executeTool, getToolDefinitions } from '../lib/agent/tools.js';
import { __setPlans } from '../lib/plans.js';
import { MemoryStore } from '../lib/store/memory.js';
import { __setStore } from '../lib/store/index.js';
import type { Lead } from '../lib/store/types.js';

let store: MemoryStore;
let lead: Lead;

beforeEach(async () => {
  store = new MemoryStore();
  __setStore(store);
  __setPlans([
    {
      id: 'completo',
      label: 'Plan Completo',
      description: 'Plan mensual',
      stripePriceId: '',
      monthlyUsd: 50,
    },
  ]);
  lead = await store.upsertLead('573001112233', {
    profile_name: 'Marcela R.',
    last_inbound_at: new Date().toISOString(),
  });
});

test('all six tools are exposed to the model', () => {
  const names = getToolDefinitions().map((t) => t.name).sort();
  assert.deepEqual(names, [
    'book_trial_class',
    'check_calendar_availability',
    'create_payment_link',
    'escalate_to_human',
    'record_conversion_event',
    'update_lead',
  ]);
});

test('every tool declares a schema the model can fill in', () => {
  for (const tool of getToolDefinitions()) {
    assert.ok(tool.description.length > 20, `${tool.name} has a usable description`);
    assert.equal((tool.parameters as { type: string }).type, 'object');
  }
});

// --- update_lead -------------------------------------------------------------

test('update_lead stores what the agent learned', async () => {
  const outcome = await executeTool(lead, 'update_lead', {
    display_name: 'Marcela',
    student_name: 'Sofía',
    student_age: 9,
    stage: 'qualified',
  });

  assert.equal(outcome.isError, undefined);
  const updated = (await store.getLeadById(lead.id))!;
  assert.equal(updated.display_name, 'Marcela');
  assert.equal(updated.student_name, 'Sofía');
  assert.equal(updated.student_age, 9);
  assert.equal(updated.stage, 'qualified');
});

test('update_lead refuses an invented stage', async () => {
  const outcome = await executeTool(lead, 'update_lead', { stage: 'muy_interesado' });

  assert.equal(outcome.isError, true);
  assert.equal((await store.getLeadById(lead.id))!.stage, 'new');
});

test('update_lead cannot claim a trial was booked', async () => {
  const outcome = await executeTool(lead, 'update_lead', { stage: 'trial_booked' });

  assert.equal(outcome.isError, true);
  assert.equal((await store.getLeadById(lead.id))!.stage, 'new');
});

test('update_lead merges tags instead of replacing them', async () => {
  await store.updateLead(lead.id, { tags: ['ctwa'] });
  const fresh = (await store.getLeadById(lead.id))!;

  await executeTool(fresh, 'update_lead', { tags: ['colombia', 'ctwa'] });

  const updated = (await store.getLeadById(lead.id))!;
  assert.deepEqual([...updated.tags].sort(), ['colombia', 'ctwa']);
});

test('update_lead appends notes rather than overwriting the previous one', async () => {
  await executeTool(lead, 'update_lead', { notes: 'quiere clases en la tarde' });
  const afterFirst = (await store.getLeadById(lead.id))!;
  await executeTool(afterFirst, 'update_lead', { notes: 'tiene dos hijos' });

  const notes = (await store.getLeadById(lead.id))!.notes ?? '';
  assert.match(notes, /clases en la tarde/);
  assert.match(notes, /dos hijos/);
});

test('update_lead rejects an impossible age', async () => {
  await executeTool(lead, 'update_lead', { student_age: 900 });
  assert.equal((await store.getLeadById(lead.id))!.student_age, null);
});

test('update_lead with nothing usable reports an error', async () => {
  const outcome = await executeTool(lead, 'update_lead', {});
  assert.equal(outcome.isError, true);
});

// --- escalate_to_human -------------------------------------------------------

test('escalate_to_human pauses the bot and ends the turn', async () => {
  const outcome = await executeTool(lead, 'escalate_to_human', {
    reason: 'missing_info',
    summary: 'Pregunta si dan certificado al terminar.',
  });

  assert.equal(outcome.stopConversation, true);

  // The parent is told someone will reply, and told it immediately — the
  // acknowledgement is sent rather than queued, because queueing it behind the
  // pause this same call sets would mean it never went out.
  const sent = store.messages.filter((m) => m.direction === 'outbound_bot');
  assert.equal(sent.length, 1, 'the parent got an acknowledgement');
  assert.match(sent[0]!.body ?? '', /Jordi/);

  const updated = (await store.getLeadById(lead.id))!;
  assert.equal(updated.bot_paused, true);
  assert.equal(updated.bot_paused_reason, 'escalated:missing_info');
  assert.match(updated.notes ?? '', /certificado/);
});

// --- create_payment_link -----------------------------------------------------

test('create_payment_link refuses a plan that does not exist', async () => {
  const outcome = await executeTool(lead, 'create_payment_link', { plan_id: 'plan_vip_inventado' });

  assert.equal(outcome.isError, true);
  assert.match(String(outcome.result), /No existe el plan/);
});

test('create_payment_link tells the model to escalate when Stripe is not set up', async () => {
  const outcome = await executeTool(lead, 'create_payment_link', { plan_id: 'completo' });

  assert.equal(outcome.isError, true);
  assert.match(String(outcome.result), /escalate_to_human/);
});

test('the payment tool only offers plan ids that exist in config', () => {
  const tool = getToolDefinitions().find((t) => t.name === 'create_payment_link')!;
  const planProperty = (tool.parameters as { properties: { plan_id: { enum: string[] } } }).properties
    .plan_id;
  assert.deepEqual(planProperty.enum, ['completo']);
});

// --- calendar ----------------------------------------------------------------

test('checking availability without a calendar tells the model to escalate', async () => {
  const outcome = await executeTool(lead, 'check_calendar_availability', {
    date_range_start: new Date().toISOString(),
    date_range_end: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  });

  assert.equal(outcome.isError, true);
  assert.match(String(outcome.result), /escalate_to_human/);
});

test('booking without a calendar does not fake a confirmation', async () => {
  const outcome = await executeTool(lead, 'book_trial_class', {
    slot_start_iso: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    student_name: 'Sofía',
    student_age: 9,
    parent_name: 'Marcela',
  });

  assert.equal(outcome.isError, true);
  assert.equal((await store.getLeadById(lead.id))!.stage, 'new');
});

// --- record_conversion_event -------------------------------------------------

test('record_conversion_event stores a Lead event with the ad click id', async () => {
  await store.updateLead(lead.id, { ctwa_clid: 'CLID_ABC' });
  const fresh = (await store.getLeadById(lead.id))!;

  const outcome = await executeTool(fresh, 'record_conversion_event', { event_name: 'Lead' });

  assert.equal(outcome.isError, undefined);
  const events = await store.listConversionEvents(lead.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.event_name, 'Lead');
  assert.equal(events[0]!.ctwa_clid, 'CLID_ABC');
  assert.equal(events[0]!.sent_to_meta, false);
});

test('the same conversion is not recorded twice', async () => {
  await executeTool(lead, 'record_conversion_event', { event_name: 'Lead' });
  await executeTool(lead, 'record_conversion_event', { event_name: 'Lead' });

  assert.equal((await store.listConversionEvents(lead.id)).length, 1);
});

test('the model cannot fire Schedule by hand', async () => {
  const outcome = await executeTool(lead, 'record_conversion_event', { event_name: 'Schedule' });

  assert.equal(outcome.isError, true);
  assert.equal((await store.listConversionEvents(lead.id)).length, 0);
});

test('a Purchase defaults to the monthly price when no value is given', async () => {
  await executeTool(lead, 'record_conversion_event', { event_name: 'Purchase' });

  const events = await store.listConversionEvents(lead.id);
  assert.equal(events[0]!.value, 50);
  assert.equal(events[0]!.currency, 'USD');
});

// --- unknown tool ------------------------------------------------------------

test('an unknown tool name is reported rather than thrown', async () => {
  const outcome = await executeTool(lead, 'make_coffee', {});
  assert.equal(outcome.isError, true);
});
