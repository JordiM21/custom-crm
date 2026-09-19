import { config } from '../config.js';
import { log } from '../logger.js';
import { MemoryStore } from './memory.js';
import { seedDemoData } from './seed.js';
import { SupabaseStore } from './supabase.js';
import type { Store } from './types.js';

let instance: Store | null = null;
let seeding: Promise<void> | null = null;

/**
 * Returns the database. Supabase when it is configured, otherwise an in-memory
 * store preloaded with demo data.
 *
 * The fallback is deliberate: the operator must be able to open the panel and
 * see a working product on day one, before any account exists. Demo mode is
 * labelled everywhere it appears so it is never mistaken for live data.
 */
export async function getStore(): Promise<Store> {
  if (instance) {
    if (seeding) await seeding;
    return instance;
  }

  if (config.supabase.url && config.supabase.serviceRoleKey) {
    instance = new SupabaseStore();
    log.info('store.ready', { kind: 'supabase' });
    return instance;
  }

  const memory = new MemoryStore();
  instance = memory;
  log.warn('store.demo_mode', {
    human: 'No hay base de datos conectada: estás viendo datos de ejemplo que se borran en cada despliegue.',
  });
  seeding = seedDemoData(memory).catch((err) => {
    log.error('store.seed_failed', { error: String(err) });
  });
  await seeding;
  seeding = null;
  return instance;
}

/** True when the panel should warn that nothing it shows is real. */
export function isDemoMode(): boolean {
  return !(config.supabase.url && config.supabase.serviceRoleKey);
}

/** Tests only. */
export function __setStore(store: Store | null): void {
  instance = store;
  seeding = null;
}

export * from './types.js';
export { MemoryStore } from './memory.js';
