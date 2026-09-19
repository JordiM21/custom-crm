import { config } from './config.js';
import { getStore } from './store/index.js';

/**
 * The kill switch (SPEC §9).
 *
 * Two independent controls:
 *   - BOT_ENABLED in the environment. Setting it to false forces the bot off
 *     and the panel cannot override it. This is the break-glass control.
 *   - A flag in app_settings, toggled from the admin panel. This is the one
 *     Jordi reaches for, because it takes effect immediately with no redeploy.
 *
 * When off, the webhook still records everything. Nothing is sent.
 */

export const BOT_ENABLED_KEY = 'bot_enabled';

export interface BotState {
  enabled: boolean;
  /** Which control is holding it off, when it is off. */
  blockedBy: 'environment' | 'panel' | null;
}

export async function getBotState(): Promise<BotState> {
  if (!config.botEnabledEnv) return { enabled: false, blockedBy: 'environment' };

  const store = await getStore();
  const enabled = await store.getSetting<boolean>(BOT_ENABLED_KEY, true);
  return enabled ? { enabled: true, blockedBy: null } : { enabled: false, blockedBy: 'panel' };
}

export async function setBotEnabled(enabled: boolean): Promise<BotState> {
  const store = await getStore();
  await store.setSetting(BOT_ENABLED_KEY, enabled);
  return getBotState();
}
