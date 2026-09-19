import { requireAuth } from '../../lib/admin/auth.js';
import { getProvider, isRealProvider } from '../../lib/ai/index.js';
import { config, setupChecklist } from '../../lib/config.js';
import { knowledgeIsComplete, loadKnowledge } from '../../lib/agent/knowledge.js';
import { sendJson, type Req, type Res } from '../../lib/http.js';
import { recentEvents } from '../../lib/logger.js';
import { getBotState } from '../../lib/killswitch.js';
import { loadPlans } from '../../lib/plans.js';
import { getStore, isDemoMode } from '../../lib/store/index.js';

/**
 * Everything the panel's dashboard needs, in one request.
 *
 * Written for a reader who will never open a log: each warning carries the
 * sentence that explains what is wrong and what it means for the business.
 */
export default async function handler(req: Req, res: Res): Promise<void> {
  if (!requireAuth(req, res)) return;

  const store = await getStore();
  const [stats, botState] = await Promise.all([store.stats(), getBotState()]);

  const knowledge = loadKnowledge();
  const plans = loadPlans();
  const checklist = setupChecklist();

  const warnings: { level: 'error' | 'warn' | 'info'; message: string }[] = [];

  if (isDemoMode()) {
    warnings.push({
      level: 'warn',
      message:
        'Estás viendo datos de ejemplo. Todo lo que aparece aquí es inventado y se borra en el próximo despliegue. Conecta Supabase para guardar datos de verdad.',
    });
  }

  if (!isRealProvider()) {
    warnings.push({
      level: 'warn',
      message:
        'No hay un proveedor de IA conectado. El bot responde con frases fijas de demostración, no con respuestas reales.',
    });
  }

  if (!knowledgeIsComplete()) {
    warnings.push({
      level: 'error',
      message: `La información del negocio está incompleta (${knowledge.unfilled.length} datos sin llenar). Mientras tanto el bot no puede dar precios ni horarios: pasa esas conversaciones a ti.`,
    });
  }

  if (!botState.enabled) {
    warnings.push({
      level: 'error',
      message:
        botState.blockedBy === 'environment'
          ? 'El bot está apagado desde la configuración del servidor (BOT_ENABLED). No se puede encender desde aquí.'
          : 'El bot está apagado. Los mensajes se guardan pero nadie responde.',
    });
  }

  if (config.environment !== 'production') {
    warnings.push({
      level: 'info',
      message:
        'Modo de pruebas: los mensajes no se envían a WhatsApp de verdad, solo se registran. Cambia ENVIRONMENT a production cuando quieras salir en vivo.',
    });
  }

  if (!plans.some((p) => p.stripePriceId)) {
    warnings.push({
      level: 'info',
      message:
        'Ningún plan tiene su precio de Stripe configurado, así que el bot no puede mandar links de pago.',
    });
  }

  sendJson(res, 200, {
    stats,
    bot: botState,
    demo: isDemoMode(),
    environment: config.environment,
    ai: { provider: getProvider().name, real: isRealProvider() },
    knowledge: { complete: knowledgeIsComplete(), missing: knowledge.unfilled.slice(0, 12) },
    plans: plans.map((p) => ({ id: p.id, label: p.label, ready: Boolean(p.stripePriceId) })),
    checklist,
    warnings,
    activity: recentEvents(60).map((e) => ({
      ts: e.ts,
      level: e.level,
      event: e.event,
      message: typeof e.human === 'string' ? e.human : null,
    })),
  });
}
