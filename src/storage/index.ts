import type { StorageConfig } from '../config/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import { toError } from '../utils/errors.js';
import { JsonlModerationStore } from './jsonl-store.js';
import { MemoryModerationStore } from './memory-store.js';
import { SqliteModerationStore } from './sqlite-store.js';
import type { ModerationStore } from './types.js';

/**
 * Build the configured store.
 *
 * `auto` prefers SQLite and falls back to JSONL when the native module is
 * unavailable — the single most common install failure, and not a good reason
 * to refuse to run.
 */
export async function createStore(
  config: StorageConfig,
  logger: Logger,
): Promise<{ store: ModerationStore; driver: 'sqlite' | 'jsonl' | 'memory' }> {
  if (config.driver === 'memory') {
    const store = new MemoryModerationStore();
    await store.init();
    logger.warn(LogEvent.CONFIG_LOADED, {
      driver: 'memory',
      message: 'Using in-memory storage; all moderation records are lost on restart',
    });
    return { store, driver: 'memory' };
  }

  if (config.driver === 'jsonl') {
    const store = new JsonlModerationStore(config.databasePath);
    await store.init();
    return { store, driver: 'jsonl' };
  }

  try {
    const store = new SqliteModerationStore(config.databasePath);
    await store.init();
    return { store, driver: 'sqlite' };
  } catch (err) {
    if (config.driver === 'sqlite') throw err;

    logger.warn(LogEvent.STORAGE_ERROR, {
      message:
        'better-sqlite3 is unavailable; falling back to JSONL storage. ' +
        'Install build tools (build-essential python3) and reinstall for SQLite.',
      err: toError(err),
    });

    const store = new JsonlModerationStore(config.databasePath);
    await store.init();
    return { store, driver: 'jsonl' };
  }
}

export { JsonlModerationStore, MemoryModerationStore, SqliteModerationStore };
