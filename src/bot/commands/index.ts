import { REST, Routes } from 'discord.js';
import type { Client } from 'discord.js';
import type { AppConfig } from '../../config/types.js';
import { LogEvent } from '../../observability/events.js';
import type { Logger } from '../../observability/logger.js';
import { toError } from '../../utils/errors.js';
import { moderationCommand } from './moderation.js';

export { handleModerationCommand, moderationCommand } from './moderation.js';

/**
 * Register slash commands on startup.
 *
 * Guild-scoped deliberately: guild commands propagate immediately, while
 * global commands can take up to an hour to appear. Nobody setting this up for
 * the first time should have to wonder whether it worked.
 */
export async function registerCommands(
  client: Client,
  config: AppConfig,
  logger: Logger,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const body = [moderationCommand.toJSON()];

  const guildIds =
    config.discord.guildIds.length > 0
      ? config.discord.guildIds
      : [...client.guilds.cache.keys()];

  if (guildIds.length === 0) {
    logger.warn(LogEvent.BOT_READY, {
      message:
        'Bot is not in any guild, so no commands were registered. Invite it, then restart.',
    });
    return;
  }

  for (const guildId of guildIds) {
    try {
      await rest.put(Routes.applicationGuildCommands(config.discord.clientId, guildId), { body });
      logger.info(LogEvent.BOT_READY, {
        guildId,
        commands: body.length,
        message: 'Slash commands registered',
      });
    } catch (err) {
      logger.error(LogEvent.PERMISSION_ERROR, {
        guildId,
        message:
          'Failed to register slash commands. Confirm the bot was invited with the ' +
          '`applications.commands` scope.',
        err: toError(err),
      });
    }
  }
}
