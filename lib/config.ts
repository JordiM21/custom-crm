/**
 * Every environment variable the service reads, in one place.
 *
 * Nothing here throws on a missing value. A half-configured deployment must
 * still boot, so that the admin panel can come up and *tell the operator what
 * is missing* instead of returning a 500 with a stack trace he cannot read.
 * Each integration decides for itself whether it has what it needs.
 */

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
}

function num(name: string, fallback: number): number {
  const v = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(v) ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = str(name).toLowerCase();
  if (v === '') return fallback;
  return v === 'true' || v === '1' || v === 'yes';
}

export const config = {
  environment: str('ENVIRONMENT', 'development') as 'development' | 'production',

  admin: {
    password: str('ADMIN_PASSWORD'),
    sessionSecret: str('SESSION_SECRET', str('ADMIN_PASSWORD')),
  },

  /** Env-level kill switch. When false it overrides the panel toggle. */
  botEnabledEnv: bool('BOT_ENABLED', true),

  /**
   * Human-like send delays. Off only in tests, where waiting 45 seconds to
   * observe a queued message proves nothing that the pacing unit tests do not.
   */
  pacingEnabled: bool('PACING_ENABLED', true),

  ai: {
    provider: str('AI_PROVIDER', 'mock') as 'mock' | 'anthropic' | 'openai-compatible',
    anthropicKey: str('ANTHROPIC_API_KEY'),
    anthropicModel: str('ANTHROPIC_MODEL', 'claude-haiku-4-5'),
    baseUrl: str('AI_BASE_URL', 'https://api.openai.com/v1'),
    apiKey: str('AI_API_KEY'),
    model: str('AI_MODEL'),
    maxTokens: int('AI_MAX_TOKENS', 600),
    costCeilingUsd: num('AI_COST_CEILING_USD', 1.0),
  },

  supabase: {
    url: str('SUPABASE_URL'),
    serviceRoleKey: str('SUPABASE_SERVICE_ROLE_KEY'),
  },

  meta: {
    phoneNumberId: str('WHATSAPP_PHONE_NUMBER_ID'),
    businessAccountId: str('WHATSAPP_BUSINESS_ACCOUNT_ID'),
    accessToken: str('META_ACCESS_TOKEN'),
    appSecret: str('META_APP_SECRET'),
    verifyToken: str('META_WEBHOOK_VERIFY_TOKEN'),
    graphVersion: str('META_GRAPH_VERSION', 'v23.0'),
    datasetId: str('META_DATASET_ID'),
  },

  google: {
    serviceAccountJson: str('GOOGLE_SERVICE_ACCOUNT_JSON'),
    calendarId: str('GOOGLE_CALENDAR_ID'),
  },

  booking: {
    timezone: str('BOOKING_TIMEZONE', 'America/Bogota'),
    hoursStart: int('BOOKING_HOURS_START', 14),
    hoursEnd: int('BOOKING_HOURS_END', 20),
    /** Never offer a slot sooner than this many hours from now. SPEC §6. */
    minLeadTimeHours: 12,
    durationMinutes: 30,
  },

  stripe: {
    secretKey: str('STRIPE_SECRET_KEY'),
  },

  ops: {
    ownerWhatsapp: str('OWNER_WHATSAPP_NUMBER'),
    cronSecret: str('CRON_SECRET'),
  },
} as const;

/** True when the service is allowed to put real messages on a real phone. */
export function isLiveSending(): boolean {
  return (
    config.environment === 'production' &&
    config.meta.accessToken !== '' &&
    config.meta.phoneNumberId !== ''
  );
}

export type CheckStatus = 'ready' | 'missing' | 'partial';

export interface SetupCheck {
  id: string;
  label: string;
  status: CheckStatus;
  /** Plain-language consequence of leaving this unconfigured. */
  detail: string;
  /** Which env vars this check covers, for the panel to display. */
  vars: string[];
  /** Ordering in the setup list — lower is more urgent. */
  order: number;
}

/**
 * The single source of truth behind the admin panel's Setup page.
 * Written for a non-technical reader: every `detail` says what breaks.
 */
export function setupChecklist(): SetupCheck[] {
  const checks: SetupCheck[] = [];

  checks.push({
    id: 'admin',
    label: 'Admin password',
    status: config.admin.password ? 'ready' : 'missing',
    detail: config.admin.password
      ? 'The panel is password protected.'
      : 'Anyone with the link can open this panel. Set ADMIN_PASSWORD before you go live.',
    vars: ['ADMIN_PASSWORD', 'SESSION_SECRET'],
    order: 1,
  });

  const dbReady = Boolean(config.supabase.url && config.supabase.serviceRoleKey);
  checks.push({
    id: 'database',
    label: 'Database',
    status: dbReady ? 'ready' : 'missing',
    detail: dbReady
      ? 'Connected to Supabase. Leads and conversations are saved permanently.'
      : 'Running on demo data. Everything you see is fake and disappears on the next deploy.',
    vars: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
    order: 2,
  });

  const metaVars = [
    config.meta.phoneNumberId,
    config.meta.accessToken,
    config.meta.appSecret,
    config.meta.verifyToken,
  ];
  const metaCount = metaVars.filter(Boolean).length;
  checks.push({
    id: 'whatsapp',
    label: 'WhatsApp',
    status: metaCount === metaVars.length ? 'ready' : metaCount === 0 ? 'missing' : 'partial',
    detail:
      metaCount === metaVars.length
        ? 'Connected to the WhatsApp Cloud API.'
        : 'Not connected. The bot cannot receive or send WhatsApp messages yet.',
    vars: [
      'WHATSAPP_PHONE_NUMBER_ID',
      'META_ACCESS_TOKEN',
      'META_APP_SECRET',
      'META_WEBHOOK_VERIFY_TOKEN',
    ],
    order: 3,
  });

  const aiReady =
    config.ai.provider === 'anthropic'
      ? Boolean(config.ai.anthropicKey)
      : config.ai.provider === 'openai-compatible'
        ? Boolean(config.ai.apiKey && config.ai.model)
        : false;
  checks.push({
    id: 'ai',
    label: 'AI provider',
    status: aiReady ? 'ready' : 'missing',
    detail: aiReady
      ? `Replies are written by ${config.ai.provider}.`
      : 'No AI account connected. The bot replies with fixed demo text, not real answers.',
    vars: ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'AI_API_KEY', 'AI_MODEL'],
    order: 4,
  });

  checks.push({
    id: 'owner',
    label: 'Your WhatsApp number',
    status: config.ops.ownerWhatsapp ? 'ready' : 'missing',
    detail: config.ops.ownerWhatsapp
      ? 'Escalations and alerts are sent to you on WhatsApp.'
      : 'You will not be alerted when a parent needs you. Set OWNER_WHATSAPP_NUMBER.',
    vars: ['OWNER_WHATSAPP_NUMBER'],
    order: 5,
  });

  const calReady = Boolean(config.google.serviceAccountJson && config.google.calendarId);
  checks.push({
    id: 'calendar',
    label: 'Google Calendar',
    status: calReady ? 'ready' : 'missing',
    detail: calReady
      ? 'The bot can read your availability and book trial classes.'
      : 'The bot cannot offer times or book trial classes. It will hand those parents to you instead.',
    vars: ['GOOGLE_SERVICE_ACCOUNT_JSON', 'GOOGLE_CALENDAR_ID'],
    order: 6,
  });

  checks.push({
    id: 'stripe',
    label: 'Stripe',
    status: config.stripe.secretKey ? 'ready' : 'missing',
    detail: config.stripe.secretKey
      ? 'The bot can send payment links.'
      : 'The bot cannot send payment links. It will hand those parents to you instead.',
    vars: ['STRIPE_SECRET_KEY'],
    order: 7,
  });

  checks.push({
    id: 'conversions',
    label: 'Meta ad tracking',
    status: config.meta.datasetId ? 'ready' : 'missing',
    detail: config.meta.datasetId
      ? 'Sales are reported back to Meta so you can see which ad produced them.'
      : 'Optional for now. Without it, Meta cannot tell you which ad produced a paying student.',
    vars: ['META_DATASET_ID'],
    order: 8,
  });

  return checks.sort((a, b) => a.order - b.order);
}
