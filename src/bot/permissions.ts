import { ChannelType, PermissionFlagsBits } from 'discord.js';
import type { Guild, GuildBasedChannel, PermissionsBitField } from 'discord.js';
import type { AppConfig } from '../config/types.js';
import type { ModerationActionType } from '../moderation/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';

export interface PermissionProblem {
  scope: 'guild' | 'voice-channel' | 'log-channel';
  channelId?: string;
  channelName?: string;
  missing: string[];
  /** Fatal problems prevent moderation from working as configured. */
  fatal: boolean;
  detail: string;
}

export interface PreflightResult {
  guildId: string;
  problems: PermissionProblem[];
  /** Action the guild can actually perform, after downgrades. */
  effectiveAction: ModerationActionType;
}

/** Guild-level permission each action needs. */
export const ACTION_PERMISSION: Record<ModerationActionType, bigint | undefined> = {
  warn: undefined,
  disconnect: PermissionFlagsBits.MoveMembers,
  kick: PermissionFlagsBits.KickMembers,
  ban: PermissionFlagsBits.BanMembers,
};

const PERMISSION_NAMES = new Map<bigint, string>([
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.Connect, 'Connect'],
  [PermissionFlagsBits.Speak, 'Speak'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.AttachFiles, 'Attach Files'],
  [PermissionFlagsBits.MoveMembers, 'Move Members'],
  [PermissionFlagsBits.KickMembers, 'Kick Members'],
  [PermissionFlagsBits.BanMembers, 'Ban Members'],
]);

function nameOf(flag: bigint): string {
  return PERMISSION_NAMES.get(flag) ?? flag.toString();
}

function missingFrom(permissions: PermissionsBitField | null, required: bigint[]): string[] {
  if (!permissions) return required.map(nameOf);
  return required.filter((flag) => !permissions.has(flag)).map(nameOf);
}

/**
 * Verify at startup that the bot can actually do what it is configured to do.
 *
 * A moderation bot that silently lacks Move Members looks identical to one
 * that never sees a violation, so this reports loudly and — unless
 * STRICT_PERMISSIONS is set — downgrades to an action it can perform rather
 * than pretending to moderate.
 */
export async function preflightGuild(
  guild: Guild,
  config: AppConfig,
  monitoredChannelIds: string[],
  actionCeiling: ModerationActionType,
  logger: Logger,
): Promise<PreflightResult> {
  const problems: PermissionProblem[] = [];
  const me = await guild.members.fetchMe();

  // -- guild-level action permission --------------------------------------
  let effectiveAction = actionCeiling;
  const actionPermission = ACTION_PERMISSION[actionCeiling];
  if (actionPermission && !me.permissions.has(actionPermission)) {
    problems.push({
      scope: 'guild',
      missing: [nameOf(actionPermission)],
      fatal: true,
      detail: `Cannot perform "${actionCeiling}" without the ${nameOf(actionPermission)} permission.`,
    });
    effectiveAction = 'warn';
  }

  // -- moderation log channel ---------------------------------------------
  const logChannel = await fetchChannel(guild, config.discord.moderationLogChannelId);
  if (!logChannel) {
    problems.push({
      scope: 'log-channel',
      channelId: config.discord.moderationLogChannelId,
      missing: ['View Channel'],
      fatal: true,
      detail: 'The configured MODERATION_LOG_CHANNEL_ID does not exist or is not visible.',
    });
  } else {
    const required = [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
    ];
    if (config.evidence.allowDiscordUpload) required.push(PermissionFlagsBits.AttachFiles);

    const missing = missingFrom(logChannel.permissionsFor(me), required);
    if (missing.length > 0) {
      problems.push({
        scope: 'log-channel',
        channelId: logChannel.id,
        channelName: logChannel.name,
        missing,
        fatal: true,
        detail: 'Moderation events cannot be reported without access to the log channel.',
      });
    }
  }

  // -- monitored voice channels -------------------------------------------
  for (const channelId of monitoredChannelIds) {
    const channel = await fetchChannel(guild, channelId);
    if (!channel) continue; // may belong to a different guild
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      continue;
    }

    const required = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect];
    if (config.voice.silenceKeepalive) required.push(PermissionFlagsBits.Speak);
    // The bot refuses to join a channel it cannot announce itself in.
    if (config.privacy.requireMonitoringNotice) required.push(PermissionFlagsBits.SendMessages);

    const missing = missingFrom(channel.permissionsFor(me), required);
    if (missing.length > 0) {
      problems.push({
        scope: 'voice-channel',
        channelId: channel.id,
        channelName: channel.name,
        missing,
        fatal: missing.includes('Connect') || missing.includes('View Channel'),
        detail: config.privacy.requireMonitoringNotice
          ? 'Send Messages is required so the bot can post the monitoring notice before listening.'
          : 'The bot cannot monitor a channel it cannot join.',
      });
    }
  }

  for (const problem of problems) {
    logger[problem.fatal ? 'error' : 'warn'](LogEvent.PERMISSION_ERROR, {
      guildId: guild.id,
      scope: problem.scope,
      channelId: problem.channelId,
      missing: problem.missing,
      detail: problem.detail,
    });
  }

  if (effectiveAction !== actionCeiling) {
    logger.warn(LogEvent.PERMISSION_ERROR, {
      guildId: guild.id,
      configuredAction: actionCeiling,
      effectiveAction,
      message: 'Downgrading moderation action because the required permission is missing',
    });
  }

  return { guildId: guild.id, problems, effectiveAction };
}

async function fetchChannel(guild: Guild, channelId: string): Promise<GuildBasedChannel | null> {
  try {
    return await guild.channels.fetch(channelId);
  } catch {
    return null;
  }
}

/** Permission integer for the bot invite URL, derived from the configuration. */
export function invitePermissions(action: ModerationActionType, allowUpload: boolean): bigint {
  let bits =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.Connect |
    PermissionFlagsBits.Speak |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.EmbedLinks;

  // Every rung up to the configured ceiling, since escalation can land on any
  // of them.
  if (action === 'disconnect' || action === 'kick' || action === 'ban') {
    bits |= PermissionFlagsBits.MoveMembers;
  }
  if (action === 'kick' || action === 'ban') bits |= PermissionFlagsBits.KickMembers;
  if (action === 'ban') bits |= PermissionFlagsBits.BanMembers;
  if (allowUpload) bits |= PermissionFlagsBits.AttachFiles;

  return bits;
}
