import { messageText, type AiProvider, type AiRequest, type AiResponse } from './types.js';

/**
 * The provider used when no AI account is connected.
 *
 * It exists so the whole pipeline — webhook, queue, pacing, cap, panel — can be
 * exercised end to end before any vendor is chosen or any key exists. It is not
 * intelligent and does not pretend to be: fixed Spanish lines that follow the
 * conversation rules (one question, short, lowercase, no price ever).
 *
 * Every reply is prefixed in the logs and shown in the panel as demo output.
 */

const OPENERS = [
  'hola! cuántos años tiene tu hijo o hija?',
  'hola! gracias por escribir. qué edad tiene el estudiante?',
];

const FOLLOW_UPS = [
  'perfecto. cómo va con el inglés ahorita, ya tiene algo de base?',
  'entiendo. qué te gustaría que mejore primero, hablar o entender?',
  'buenísimo. te gustaría que agendemos una clase de prueba?',
  'dale. qué días le quedan mejor, entre semana o fin de semana?',
];

const ESCALATE = 'te entiendo. eso lo ve Jordi directamente contigo, le paso tu mensaje';

/** Anything that must reach a human, regardless of what a model would say. */
const ESCALATION_HINTS = [
  'descuento',
  'reembolso',
  'devol',
  'queja',
  'problema',
  'barato',
  'precio especial',
  'discapacid',
  'autis',
  'tdah',
  'dificultad',
];

export class MockProvider implements AiProvider {
  readonly name = 'mock';

  isConfigured(): boolean {
    // Always "configured" — that is the point. But callers check
    // `isRealProvider()` before trusting a reply on a live number.
    return true;
  }

  async complete(request: AiRequest): Promise<AiResponse> {
    const turns = request.messages.filter((m) => m.role === 'user').length;
    const last = messageText(request.messages.at(-1) ?? { role: 'user', content: [] }).toLowerCase();

    let text: string;
    if (ESCALATION_HINTS.some((hint) => last.includes(hint))) {
      text = ESCALATE;
    } else if (turns <= 1) {
      text = OPENERS[turns % OPENERS.length]!;
    } else {
      text = FOLLOW_UPS[(turns - 2) % FOLLOW_UPS.length]!;
    }

    return {
      text,
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      stopReason: 'end_turn',
    };
  }
}
