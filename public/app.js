/* =============================================================================
   LET Junior — panel de administración
   Vanilla JS, no build step. The person using this is not a developer, so:
   every failure produces a sentence on screen, never a silent console error.
   ============================================================================= */

const $ = (id) => document.getElementById(id);

const state = {
  page: 'dashboard',
  stage: 'all',
  search: '',
  leads: [],
  stages: {},
  openLeadId: null,
  refreshTimer: null,
};

/* --- Helpers -------------------------------------------------------------- */

function toast(message, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });

  if (response.status === 401) {
    showLogin();
    throw new Error('unauthorised');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.message || body.error || 'Algo salió mal. Intenta de nuevo.');
  }
  return body;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function initials(name) {
  return String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** Stable colour per contact, so a face is recognisable between visits. */
function avatarColor(seed) {
  const palette = ['#0071e3', '#34c759', '#ff9500', '#af52de', '#ff2d55', '#5ac8fa', '#ffcc00'];
  let hash = 0;
  for (const ch of String(seed)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function relativeTime(iso) {
  if (!iso) return 'sin mensajes';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `hace ${days} d`;
  return new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
}

function clockTime(iso) {
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

const STAGE_TONE = {
  new: 'neutral',
  engaged: 'blue',
  qualified: 'blue',
  trial_booked: 'orange',
  trial_completed: 'orange',
  enrolled: 'green',
  lost: 'neutral',
  unqualified: 'neutral',
  human_handling: 'red',
};

/* --- Auth ----------------------------------------------------------------- */

function showLogin() {
  $('login').classList.remove('hidden');
  $('app').classList.add('hidden');
  clearInterval(state.refreshTimer);
}

function showApp() {
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('login-error');
  error.classList.add('hidden');

  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('password').value }),
    });
    $('password').value = '';
    showApp();
    start();
  } catch (err) {
    error.textContent = err.message === 'unauthorised' ? 'Contraseña incorrecta.' : err.message;
    error.classList.remove('hidden');
  }
});

/* --- Navigation ----------------------------------------------------------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => goTo(tab.dataset.page));
});

function goTo(page) {
  state.page = page;
  document.querySelectorAll('.tab').forEach((t) =>
    t.setAttribute('aria-selected', String(t.dataset.page === page)),
  );
  ['dashboard', 'leads', 'setup'].forEach((name) =>
    $(`page-${name}`).classList.toggle('hidden', name !== page),
  );
  if (page === 'leads') loadLeads();
}

/* --- Dashboard ------------------------------------------------------------ */

async function loadState() {
  let data;
  try {
    data = await api('/api/admin/state');
  } catch (err) {
    if (err.message !== 'unauthorised') {
      $('banners').innerHTML = banner(
        'error',
        `No se pudo cargar la información: ${escapeHtml(err.message)}`,
      );
    }
    return;
  }

  renderBanners(data.warnings);
  renderTiles(data.stats, data);
  renderPipeline(data.stats);
  renderActivity(data.activity);
  renderChecklist(data.checklist);
  renderPlans(data.plans);
  renderKnowledge(data.knowledge);
  renderBotSwitch(data.bot);
}

function banner(level, message) {
  const glyph = level === 'error' ? '!' : level === 'warn' ? '!' : 'i';
  return `<div class="banner ${level}"><span class="banner-icon">${glyph}</span><span>${message}</span></div>`;
}

function renderBanners(warnings) {
  const all = warnings || [];
  // Only real problems belong on the first screen. Informational notices live
  // on the Conexiones page, where the reader is already looking at settings.
  const urgent = all.filter((w) => w.level === 'error' || w.level === 'warn');
  const info = all.filter((w) => w.level === 'info');

  $('banners').innerHTML = urgent.map((w) => banner(w.level, escapeHtml(w.message))).join('');
  $('setup-banners').innerHTML = info.map((w) => banner(w.level, escapeHtml(w.message))).join('');
}

function renderTiles(stats, data) {
  const tiles = [
    { label: 'Contactos', value: stats.total, note: `${stats.newToday} nuevos hoy` },
    {
      label: 'Estudiantes inscritos',
      value: stats.enrolled,
      note: `USD ${stats.monthlyRevenueUsd} al mes`,
      accent: true,
    },
    {
      label: 'Esperando tu respuesta',
      value: stats.paused,
      note: stats.paused ? 'necesitan que escribas tú' : 'nada pendiente',
    },
    { label: 'Mensajes hoy', value: stats.messagesToday, note: `${stats.queuePending} en cola` },
    {
      label: 'Proveedor de IA',
      value: data.ai.real ? 'Conectado' : 'Demo',
      note: escapeHtml(data.ai.provider),
    },
  ];

  $('tiles').innerHTML = tiles
    .map(
      (t) => `
      <div class="tile ${t.accent ? 'accent' : ''}">
        <div class="tile-label">${escapeHtml(t.label)}</div>
        <div class="tile-value">${escapeHtml(t.value)}</div>
        <div class="tile-note">${escapeHtml(t.note)}</div>
      </div>`,
    )
    .join('');
}

const PIPELINE_ORDER = [
  'new',
  'engaged',
  'qualified',
  'trial_booked',
  'trial_completed',
  'enrolled',
];

function renderPipeline(stats) {
  const labels = state.stages;
  const max = Math.max(1, ...PIPELINE_ORDER.map((s) => stats.byStage[s] || 0));

  $('pipeline').innerHTML = PIPELINE_ORDER.map((stage) => {
    const count = stats.byStage[stage] || 0;
    const pct = Math.round((count / max) * 100);
    return `
      <div class="pipe-row" data-stage="${stage}">
        <span class="pipe-name">${escapeHtml(labels[stage] || stage)}</span>
        <span class="pipe-bar"><span class="pipe-fill" style="width:${pct}%"></span></span>
        <span class="pipe-count">${count}</span>
      </div>`;
  }).join('');

  $('pipeline')
    .querySelectorAll('.pipe-row')
    .forEach((row) =>
      row.addEventListener('click', () => {
        state.stage = row.dataset.stage;
        goTo('leads');
        renderChips();
      }),
    );
}

function renderActivity(events) {
  const shown = (events || []).filter((e) => e.message);

  if (shown.length === 0) {
    $('activity').innerHTML =
      '<div class="empty"><strong>Todo tranquilo</strong>Aquí aparecerá lo que vaya pasando.</div>';
    return;
  }

  $('activity').innerHTML = shown
    .slice(0, 30)
    .map(
      (e) => `
      <div class="event">
        <span class="event-dot ${e.level}"></span>
        <span class="event-body">${escapeHtml(e.message)}</span>
        <span class="event-time">${clockTime(e.ts)}</span>
      </div>`,
    )
    .join('');
}

/* --- Kill switch ---------------------------------------------------------- */

function renderBotSwitch(bot) {
  const el = $('bot-switch');
  el.dataset.on = String(bot.enabled);
  $('bot-label').textContent = bot.enabled ? 'Bot activo' : 'Bot apagado';
  el.disabled = bot.blockedBy === 'environment';
  el.title =
    bot.blockedBy === 'environment'
      ? 'Apagado desde la configuración del servidor (BOT_ENABLED)'
      : bot.enabled
        ? 'Apagar el bot: los mensajes se guardan pero nadie responde'
        : 'Encender el bot';
}

$('bot-switch').addEventListener('click', async () => {
  const el = $('bot-switch');
  const turningOn = el.dataset.on !== 'true';

  if (!turningOn && !confirm('¿Apagar el bot? Los mensajes se seguirán guardando, pero nadie va a responder hasta que lo vuelvas a encender.')) {
    return;
  }

  try {
    const result = await api('/api/admin/bot', {
      method: 'POST',
      body: JSON.stringify({ enabled: turningOn }),
    });
    renderBotSwitch(result);
    toast(result.message || (result.enabled ? 'Bot encendido' : 'Bot apagado'), Boolean(result.message));
    loadState();
  } catch (err) {
    toast(err.message, true);
  }
});

/* --- Leads ---------------------------------------------------------------- */

function renderChips() {
  const order = ['all', ...PIPELINE_ORDER, 'human_handling', 'lost', 'unqualified'];
  $('stage-chips').innerHTML = order
    .map(
      (stage) => `
      <button class="chip" data-stage="${stage}" aria-pressed="${state.stage === stage}">
        ${escapeHtml(stage === 'all' ? 'Todos' : state.stages[stage] || stage)}
      </button>`,
    )
    .join('');

  $('stage-chips')
    .querySelectorAll('.chip')
    .forEach((chip) =>
      chip.addEventListener('click', () => {
        state.stage = chip.dataset.stage;
        renderChips();
        loadLeads();
      }),
    );
}

let searchTimer;
$('search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = event.target.value.trim();
    loadLeads();
  }, 260);
});

async function loadLeads() {
  const list = $('lead-list');
  if (state.leads.length === 0) {
    list.innerHTML = Array.from({ length: 4 })
      .map(() => '<div class="row"><div class="skeleton" style="height:38px;border-radius:50%"></div><div class="skeleton" style="height:32px"></div><div></div></div>')
      .join('');
  }

  const params = new URLSearchParams();
  if (state.stage !== 'all') params.set('stage', state.stage);
  if (state.search) params.set('search', state.search);

  let data;
  try {
    data = await api(`/api/admin/leads?${params}`);
  } catch (err) {
    if (err.message !== 'unauthorised') {
      list.innerHTML = `<div class="empty"><strong>No se pudieron cargar los contactos</strong>${escapeHtml(err.message)}</div>`;
    }
    return;
  }

  state.leads = data.leads;
  state.stages = data.stages;
  if (!$('stage-chips').children.length) renderChips();

  if (data.leads.length === 0) {
    list.innerHTML = state.search
      ? `<div class="empty"><strong>Sin resultados</strong>Nadie coincide con "${escapeHtml(state.search)}".</div>`
      : '<div class="empty"><strong>Todavía no hay contactos aquí</strong>Cuando alguien escriba por WhatsApp, aparecerá en esta lista.</div>';
    return;
  }

  list.innerHTML = data.leads.map(leadRow).join('');
  list.querySelectorAll('.row').forEach((row) =>
    row.addEventListener('click', () => openLead(row.dataset.id)),
  );
}

function leadRow(lead) {
  const sub = [
    lead.student_name ? `${lead.student_name}${lead.student_age ? `, ${lead.student_age} años` : ''}` : null,
    relativeTime(lead.last_message_at),
  ]
    .filter(Boolean)
    .join(' · ');

  return `
    <button class="row" data-id="${lead.id}">
      <span class="avatar" style="background:${avatarColor(lead.wa_id)}">${escapeHtml(initials(lead.name))}</span>
      <span class="row-main">
        <span class="row-name">
          ${escapeHtml(lead.name)}
          ${lead.from_ad ? '<span class="dot-ad" title="Llegó desde un anuncio"></span>' : ''}
        </span>
        <span class="row-sub">${escapeHtml(sub)}</span>
      </span>
      <span class="row-side">
        ${lead.bot_paused ? '<span class="badge red">Te toca a ti</span>' : ''}
        <span class="badge ${STAGE_TONE[lead.stage] || 'neutral'}">${escapeHtml(lead.stage_label)}</span>
      </span>
    </button>`;
}

/* --- Lead detail ---------------------------------------------------------- */

function closeSheet() {
  $('sheet').classList.remove('open');
  $('sheet').setAttribute('aria-hidden', 'true');
  $('scrim').classList.remove('open');
  state.openLeadId = null;
}

$('sheet-close').addEventListener('click', closeSheet);
$('scrim').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheet();
});

async function openLead(id) {
  state.openLeadId = id;
  $('sheet').classList.add('open');
  $('sheet').setAttribute('aria-hidden', 'false');
  $('scrim').classList.add('open');
  $('sheet-body').innerHTML =
    '<div class="skeleton" style="height:120px;margin-bottom:14px"></div><div class="skeleton" style="height:240px"></div>';

  let data;
  try {
    data = await api(`/api/admin/lead?id=${encodeURIComponent(id)}`);
  } catch (err) {
    $('sheet-body').innerHTML = `<div class="empty"><strong>No se pudo abrir</strong>${escapeHtml(err.message)}</div>`;
    return;
  }

  renderSheet(data);
}

function renderSheet(data) {
  const lead = data.lead;

  $('sheet-name').textContent = lead.name;
  $('sheet-sub').textContent = `+${lead.wa_id} · ${lead.stage_label}`;

  const windowNote = lead.window_open
    ? 'Puedes responder ahora'
    : lead.hours_since_inbound === null
      ? 'Todavía no ha escrito'
      : `Cerrada hace ${lead.hours_since_inbound - 24} h`;

  const fields = [
    ['Estudiante', lead.student_name || '—'],
    ['Edad', lead.student_age ?? '—'],
    ['Etapa', lead.stage_label],
    ['Primer contacto', new Date(lead.first_contact_at).toLocaleDateString('es-CO')],
    ['Último mensaje', relativeTime(lead.last_message_at)],
    ['Ventana de 24 h', windowNote],
    ['Origen', lead.ctwa_clid ? `Anuncio: ${lead.ctwa_headline || lead.ctwa_source_id || 'sí'}` : 'Orgánico'],
    ['Costo en IA', `USD ${Number(lead.cost_usd || 0).toFixed(3)}`],
  ];

  const pausedCard = lead.bot_paused
    ? `<div class="banner warn" style="margin-bottom:14px">
         <span class="banner-icon">!</span>
         <span>El bot está en pausa para este contacto${lead.bot_paused_reason ? ` (${escapeHtml(pauseReason(lead.bot_paused_reason))})` : ''}. Escríbele tú desde WhatsApp, o reactiva el bot abajo.</span>
       </div>`
    : '';

  const thread = (data.messages || []).length
    ? `<div class="thread">${data.messages.map(bubble).join('')}</div>`
    : '<div class="empty" style="padding:28px">Sin mensajes todavía.</div>';

  $('sheet-body').innerHTML = `
    ${pausedCard}

    <div class="btn-row" style="margin-bottom:14px">
      <a class="btn primary" href="${escapeHtml(lead.whatsapp_url)}" target="_blank" rel="noopener">Abrir en WhatsApp</a>
      <button class="btn ${lead.bot_paused ? 'secondary' : 'danger'}" id="toggle-pause">
        ${lead.bot_paused ? 'Reactivar el bot' : 'Pausar el bot'}
      </button>
    </div>

    <div class="card">${fields.map(([k, v]) => field(k, v)).join('')}</div>

    <h3>Conversación</h3>
    <div class="card">${thread}</div>

    <h3>Cambiar etapa</h3>
    <div class="card">
      <select class="control" id="stage-select">
        ${Object.entries(data.stages)
          .map(
            ([value, label]) =>
              `<option value="${value}" ${value === lead.stage ? 'selected' : ''}>${escapeHtml(label)}</option>`,
          )
          .join('')}
      </select>
    </div>

    <h3>Notas</h3>
    <div class="card">
      <textarea class="control" id="notes" placeholder="Lo que quieras recordar de este contacto">${escapeHtml(lead.notes || '')}</textarea>
      <button class="btn secondary full" id="save-notes" style="margin-top:10px">Guardar</button>
    </div>
  `;

  $('toggle-pause').addEventListener('click', () =>
    patchLead(lead.id, { action: lead.bot_paused ? 'resume' : 'pause' }),
  );
  $('stage-select').addEventListener('change', (e) =>
    patchLead(lead.id, { stage: e.target.value }, 'Etapa actualizada'),
  );
  $('save-notes').addEventListener('click', () =>
    patchLead(lead.id, { notes: $('notes').value }, 'Nota guardada'),
  );
}

function pauseReason(reason) {
  const map = {
    human_replied: 'le respondiste desde tu teléfono',
    rate_limit: 'demasiados mensajes seguidos',
    paused_from_panel: 'lo pausaste desde aquí',
    'escalated:price_negotiation': 'pidió un descuento',
    'escalated:refund_request': 'pidió un reembolso',
    'escalated:complaint': 'puso una queja',
    'escalated:child_wellbeing': 'mencionó un tema del niño',
    'escalated:unsupported_media': 'mandó una foto o audio',
    'escalated:ai_unavailable': 'falló el servicio de IA',
    'escalated:cost_ceiling': 'la conversación se pasó del límite de costo',
  };
  return map[reason] || reason;
}

function field(label, value) {
  return `<div class="field"><span class="field-label">${escapeHtml(label)}</span><span class="field-value">${escapeHtml(value)}</span></div>`;
}

function bubble(message) {
  const who =
    message.direction === 'inbound'
      ? 'Ellos'
      : message.direction === 'outbound_human'
        ? 'Tú'
        : 'Bot';
  return `
    <div class="bubble ${message.direction}">
      ${escapeHtml(message.body || '(sin texto)')}
      <div class="bubble-meta">${who} · ${clockTime(message.created_at)}</div>
    </div>`;
}

async function patchLead(id, patch, successMessage = 'Listo') {
  try {
    await api(`/api/admin/lead?id=${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    toast(successMessage);
    await openLead(id);
    loadLeads();
    loadState();
  } catch (err) {
    toast(err.message, true);
  }
}

/* --- Setup ---------------------------------------------------------------- */

function renderChecklist(checks) {
  $('checklist').innerHTML = (checks || [])
    .map(
      (c) => `
      <div class="check">
        <span class="check-mark ${c.status}">${c.status === 'ready' ? '✓' : c.status === 'partial' ? '!' : ''}</span>
        <span class="check-body">
          <span class="check-title">${escapeHtml(c.label)}</span>
          <div class="check-detail">${escapeHtml(c.detail)}</div>
          ${
            c.status !== 'ready'
              ? `<div class="check-vars">${c.vars.map((v) => `<span class="var">${escapeHtml(v)}</span>`).join('')}</div>`
              : ''
          }
        </span>
      </div>`,
    )
    .join('');
}

function renderPlans(plans) {
  if (!plans || plans.length === 0) {
    $('plans').innerHTML = '<div class="empty">No hay planes configurados.</div>';
    return;
  }

  $('plans').innerHTML = plans
    .map(
      (p) => `
      <div class="check">
        <span class="check-mark ${p.ready ? 'ready' : 'missing'}">${p.ready ? '✓' : ''}</span>
        <span class="check-body">
          <span class="check-title">${escapeHtml(p.label)}</span>
          <div class="check-detail">${
            p.ready
              ? 'Listo: el bot puede mandar el link de pago.'
              : 'Falta el precio de Stripe. Ponlo en config/plans.json.'
          }</div>
        </span>
      </div>`,
    )
    .join('');
}

function renderKnowledge(knowledge) {
  if (knowledge.complete) {
    $('knowledge').innerHTML =
      '<div class="check-detail">La información del negocio está completa. El bot puede responder precios, horarios y políticas.</div>';
    return;
  }

  $('knowledge').innerHTML = `
    <div class="check-detail">
      Faltan ${knowledge.missing.length} datos por llenar en <code>knowledge/business.md</code>.
      Mientras tanto el bot no da precios ni horarios: pasa esas conversaciones a ti.
    </div>
    <div class="check-vars" style="margin-top:10px">
      ${knowledge.missing.map((m) => `<span class="var">${escapeHtml(m)}</span>`).join('')}
    </div>`;
}

/* --- Boot ----------------------------------------------------------------- */

function start() {
  loadLeads().then(() => {
    renderChips();
    loadState();
  });

  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    loadState();
    if (state.page === 'leads') loadLeads();
  }, 20000);
}

(async function boot() {
  try {
    const auth = await api('/api/admin/login');
    if (auth.authenticated) {
      showApp();
      start();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
