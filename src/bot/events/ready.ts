import { ChannelType } from 'discord.js';
import type { Guild, VoiceBasedChannel } from 'discord.js';
import { LogEvent } from '../../observability/events.js';
import { toError } from '../../utils/errors.js';
import type { BotContext } from '../context.js';
import { registerCommands } from '../commands/index.js';
import { preflightGuild } from '../permissions.js';
import { postMonitoringNotice } from '../notice.js';

/**
 * Startup work: register commands, verify permissions, and rejoin any
 * already-populated monitored channels.
 */
export async function onReady(ctx: BotContext): Promise<void> {
  const { client, config, logger } = ctx;

  logger.info(LogEvent.BOT_READY, {
    userId: client.user?.id,
    tag: client.user?.tag,
    guilds: client.guilds.cache.size,
  });

  await registerCommands(client, config, logger);

  const guilds =
    config.discord.guildIds.length > 0
      ? config.discord.guildIds
          .map((id) => client.guilds.cache.get(id))
          .filter((g): g is Guild => Boolean(g))
      : [...client.guilds.cache.values()];

  let fatalProblems = 0;

  for (const guild of guilds) {
    try {
      const settings = await ctx.settings.get(guild.id);
      const result = await preflightGuild(
        guild,
        config,
        settings.monitoredChannelIds,
        settings.actionCeiling,
        logger,
      );

      fatalProblems += result.problems.filter((p) => p.fatal).length;

      if (result.effectiveAction !== settings.actionCeiling) {
        await ctx.settings.update(guild.id, { actionCeiling: result.effectiveAction });
        await ctx.reporter.postAlert(
          '⚠️ Moderation action downgraded',
          `The bot lacks the permission required for \`${settings.actionCeiling}\`, so the ` +
            `maximum action has been reduced to \`${result.effectiveAction}\`. Grant the missing ` +
            `permission and restart to restore it.`,
        );
      }

      await rejoinPopulatedChannels(guild, ctx);
    } catch (err) {
      logger.error(LogEvent.PERMISSION_ERROR, {
        guildId: guild.id,
        message: 'Startup checks failed for this guild',
        err: toError(err),
      });
    }
  }

  if (fatalProblems > 0 && config.ops.strictPermissions) {
    logger.error(LogEvent.PERMISSION_ERROR, {
      fatalProblems,
      message: 'STRICT_PERMISSIONS is enabled and required permissions are missing; exiting',
    });
    throw new Error(
      `Startup aborted: ${fatalProblems} fatal permission problem(s). ` +
        `Fix them, or set STRICT_PERMISSIONS=false to run with degraded capability.`,
    );
  }

  await ctx.reporter.postStartupSummary({
    'Speech-to-text': `${config.stt.provider}/${config.stt.model}`,
    'Verify model': config.stt.verifyModel,
    'Dry run': String(config.moderation.dryRun),
    'Max action': config.moderation.actionCeiling,
    'Transcript logging': String(config.privacy.transcriptLogging),
    'Violation audio': String(config.evidence.enabled),
    Rules: String(ctx.rules.ruleCount),
  });
}

/**
 * Rejoin monitored channels that already have people in them, so a restart
 * does not silently stop moderating until someone happens to rejoin.
 */
async function rejoinPopulatedChannels(guild: Guild, ctx: BotContext): Promise<void> {
  if (!ctx.config.discord.autoJoin) return;

  const settings = await ctx.settings.get(guild.id);
  if (!settings.moderationEnabled) return;
  if (ctx.voice.getSession(guild.id)) return;

  for (const channelId of settings.monitoredChannelIds) {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildVoice) continue;

    const voiceChannel = channel as VoiceBasedChannel;
    const humans = voiceChannel.members.filter((m) => !m.user.bot).size;
    if (humans === 0) continue;

    const announced = await postMonitoringNotice(voiceChannel, ctx.config, ctx.logger);
    if (!announced) continue;

    try {
      await ctx.voice.join(voiceChannel);
    } catch (err) {
      ctx.logger.error(LogEvent.DISCORD_VOICE_ERROR, {
        guildId: guild.id,
        channelId,
        message: 'Failed to rejoin a populated monitored channel',
        err: toError(err),
      });
    }
    return; // one voice connection per guild
  }
}
