import { MessageFlags } from 'discord.js';
import type { Interaction } from 'discord.js';
import { LogEvent } from '../../observability/events.js';
import { toError } from '../../utils/errors.js';
import type { BotContext } from '../context.js';
import { handleModerationCommand } from '../commands/moderation.js';

export function registerInteractionHandler(ctx: BotContext): void {
  ctx.client.on('interactionCreate', (interaction: Interaction) => {
    void dispatch(interaction, ctx);
  });
}

async function dispatch(interaction: Interaction, ctx: BotContext): Promise<void> {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'moderation') return;

  try {
    await handleModerationCommand(interaction, ctx);
  } catch (err) {
    const error = toError(err);
    ctx.logger.error(LogEvent.MODERATION_ERROR, {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      command: interaction.commandName,
      subcommand: interaction.options.getSubcommand(false),
      err: error,
    });

    // Never leave an interaction hanging — an unanswered command shows the
    // user a confusing "application did not respond".
    const message = 'Something went wrong running that command. Check the bot logs.';
    try {
      if (interaction.deferred) {
        await interaction.editReply(message);
      } else if (!interaction.replied) {
        await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      }
    } catch {
      // The interaction token expired; nothing more we can do.
    }
  }
}
