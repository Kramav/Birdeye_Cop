import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction, GuildMember } from 'discord.js';
import type { AppConfig } from '../../config/types.js';
import { LogEvent } from '../../observability/events.js';
import type { Logger } from '../../observability/logger.js';

/**
 * Whether the invoking member may change moderation settings.
 *
 * `default_member_permissions` on the command already hides it from ordinary
 * members, but a server administrator can override that in Server Settings —
 * so authorization is re-checked here at execution time. The command
 * definition is a UI hint; this is the actual access control.
 */
export function isAuthorized(interaction: ChatInputCommandInteraction, config: AppConfig): boolean {
  const member = interaction.member as GuildMember | null;
  if (!member || !interaction.guild) return false;

  if (typeof member.permissions !== 'string' && member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    return true;
  }

  const roleId = config.discord.moderatorRoleId;
  if (roleId && 'cache' in member.roles && member.roles.cache.has(roleId)) {
    return true;
  }

  return false;
}

/**
 * Enforce authorization, replying and logging on denial.
 *
 * Returns true when the caller may proceed.
 */
export async function requireAdmin(
  interaction: ChatInputCommandInteraction,
  config: AppConfig,
  logger: Logger,
): Promise<boolean> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: 'Moderation commands can only be used inside a server.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  if (isAuthorized(interaction, config)) return true;

  logger.warn(LogEvent.COMMAND_DENIED, {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    command: interaction.commandName,
    subcommand: interaction.options.getSubcommand(false),
  });

  await interaction.reply({
    content:
      'You need the **Manage Server** permission' +
      (config.discord.moderatorRoleId ? ' or the configured moderator role' : '') +
      ' to use this command.',
    flags: MessageFlags.Ephemeral,
  });
  return false;
}
