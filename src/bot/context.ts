import type { Client } from 'discord.js';
import type { AppConfig } from '../config/types.js';
import type { RulesService } from '../moderation/rules-service.js';
import type { Logger } from '../observability/logger.js';
import type { ModerationStore } from '../storage/types.js';
import type { GuildSettingsService } from '../storage/settings-store.js';
import type { VoiceManager } from '../voice/receiver.js';
import type { RetentionSweeper } from '../evidence/store.js';
import type { ModerationReporter } from './log-channel.js';

/** Everything a command or event handler needs, assembled once in index.ts. */
export interface BotContext {
  client: Client;
  config: AppConfig;
  logger: Logger;
  store: ModerationStore;
  settings: GuildSettingsService;
  rules: RulesService;
  voice: VoiceManager;
  reporter: ModerationReporter;
  sweeper: RetentionSweeper;
}
