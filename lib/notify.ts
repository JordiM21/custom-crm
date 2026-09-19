import { config } from './config.js';
import { log } from './logger.js';
import { alertOwner } from './whatsapp.js';

/**
 * Telling Jordi that a parent needs him.
 *
 * This is deliberately more than one channel, because the obvious one is not
 * reliable: Meta applies the same 24-hour rule to Jordi's own number, so a
 * WhatsApp alert is rejected whenever he has not written to the business
 * number that day. A handoff nobody hears about is a lead lost.
 *
 * Every configured channel is tried, in parallel, and a failure in one never
 * stops the others. If every channel fails — or none is configured — that is
 * logged as an error and surfaces in the panel, because silent alerting is
 * worse than no alerting.
 */

export type Channel = 'whatsapp' | 'email' | 'webhook';

export interface NotifyResult {
  delivered: Channel[];
  failed: { channel: Channel; error: string }[];
  /** True when nothing at all reached him. */
  silent: boolean;
}

export interface Notification {
  /** One line, used as the email subject and the push title. */
  title: string;
  /** The detail. Plain text; each channel formats it as it needs. */
  body: string;
  /** Deep link to the contact in the admin panel, when there is one. */
  url?: string;
  /** For the webhook payload, so downstream tooling can branch on it. */
  kind: 'escalation' | 'booking' | 'alert';
}

/** Which channels are set up. Drives the panel's Conexiones page. */
export function configuredChannels(): Channel[] {
  const channels: Channel[] = [];
  if (config.ops.ownerWhatsapp) channels.push('whatsapp');
  if (config.notify.resendApiKey && config.notify.emailTo) channels.push('email');
  if (config.notify.webhookUrl) channels.push('webhook');
  return channels;
}

export async function notifyOwner(notification: Notification): Promise<NotifyResult> {
  const channels = configuredChannels();

  if (channels.length === 0) {
    log.error('notify.no_channels', {
      title: notification.title,
      human:
        'Un contacto necesita tu atención pero no hay ningún canal de aviso configurado. Revísalo en el panel.',
    });
    return { delivered: [], failed: [], silent: true };
  }

  const attempts = await Promise.all(
    channels.map(async (channel) => {
      try {
        const ok = await deliver(channel, notification);
        return { channel, ok, error: ok ? undefined : 'rejected' };
      } catch (err) {
        return { channel, ok: false, error: String(err) };
      }
    }),
  );

  const delivered = attempts.filter((a) => a.ok).map((a) => a.channel);
  const failed = attempts
    .filter((a) => !a.ok)
    .map((a) => ({ channel: a.channel, error: a.error ?? 'unknown' }));

  if (delivered.length === 0) {
    log.error('notify.all_channels_failed', {
      title: notification.title,
      failed,
      human: `No se te pudo avisar por ningún canal: ${notification.title}. El contacto igual aparece en el panel.`,
    });
  } else {
    log.info('notify.sent', { title: notification.title, delivered, failed });
  }

  return { delivered, failed, silent: delivered.length === 0 };
}

async function deliver(channel: Channel, notification: Notification): Promise<boolean> {
  switch (channel) {
    case 'whatsapp':
      return sendWhatsapp(notification);
    case 'email':
      return sendEmail(notification);
    case 'webhook':
      return sendWebhook(notification);
  }
}

function plainText(notification: Notification): string {
  return [notification.title, '', notification.body, notification.url ? `\n${notification.url}` : '']
    .filter((line) => line !== undefined)
    .join('\n')
    .trim();
}

async function sendWhatsapp(notification: Notification): Promise<boolean> {
  const result = await alertOwner(plainText(notification));
  return result.ok;
}

/**
 * Email through Resend.
 *
 * Chosen because it is one API key and one POST — no SMTP settings, no
 * domain setup to get started (their onboarding sender works immediately),
 * and a free tier that covers this volume many times over.
 */
async function sendEmail(notification: Notification): Promise<boolean> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.notify.resendApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: config.notify.emailFrom,
      to: [config.notify.emailTo],
      subject: notification.title,
      text: plainText(notification),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`resend ${response.status}: ${detail.slice(0, 200)}`);
  }
  return true;
}

/**
 * A plain POST to any URL.
 *
 * This is the "anything" channel: point it at Telegram, Slack, Discord, ntfy,
 * Zapier, Make, or a phone-push service, and it works without this codebase
 * knowing which one. The payload carries both a ready-made `text` for services
 * that just render a message, and the structured fields for those that do not.
 */
async function sendWebhook(notification: Notification): Promise<boolean> {
  const response = await fetch(config.notify.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      text: plainText(notification),
      title: notification.title,
      body: notification.body,
      url: notification.url ?? null,
      kind: notification.kind,
      source: 'letjunior-wa-agent',
      at: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    throw new Error(`webhook ${response.status}`);
  }
  return true;
}
