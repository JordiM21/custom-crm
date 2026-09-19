import { config } from '../config.js';
import { log } from '../logger.js';
import type { Plan } from '../plans.js';

/**
 * Stripe Payment Links (SPEC §6).
 *
 * Form-encoded fetch rather than the stripe package — one endpoint, and the
 * SDK's cold-start cost buys nothing here.
 */

export function stripeIsConfigured(): boolean {
  return Boolean(config.stripe.secretKey);
}

export interface PaymentLink {
  url: string;
  id: string;
}

export async function createPaymentLink(plan: Plan, leadWaId: string): Promise<PaymentLink> {
  if (!stripeIsConfigured()) throw new Error('stripe not configured');
  if (!plan.stripePriceId) {
    throw new Error(`plan "${plan.id}" has no Stripe price id configured`);
  }

  const form = new URLSearchParams();
  form.set('line_items[0][price]', plan.stripePriceId);
  form.set('line_items[0][quantity]', '1');
  // So a payment can be traced back to the conversation that produced it.
  form.set('metadata[wa_id]', leadWaId);
  form.set('metadata[plan_id]', plan.id);

  const response = await fetch('https://api.stripe.com/v1/payment_links', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.stripe.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });

  const body = (await response.json()) as { id?: string; url?: string; error?: { message?: string } };

  if (!response.ok || !body.url || !body.id) {
    const message = body.error?.message ?? `http ${response.status}`;
    log.error('stripe.payment_link_failed', {
      plan: plan.id,
      message,
      human: 'No se pudo crear el link de pago. El contacto pasó a ti.',
    });
    throw new Error(`stripe: ${message}`);
  }

  log.info('stripe.payment_link_created', { plan: plan.id, link_id: body.id });
  return { url: body.url, id: body.id };
}
