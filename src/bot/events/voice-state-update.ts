import { ChannelType } from 'discord.js';
import type { VoiceState } from 'discord.js';
import { LogEvent } from '../../observability/events.js';
import { toError } from '../../utils/errors.js';
import type { BotContext } from '../context.js';
import { postMonitoringNotice } from '../notice.js';

export function registerVoiceStateHandler(ctx: BotContext): void {
  ctx.client.on('voiceStateUpdate', (oldState: VoiceState, newState: VoiceState) => {
    void handle(oldState, newState, ctx).catch((err: unknown) => {
      ctx.logger.error(LogEvent.DISCORD_VOICE_ERROR, {
        guildId: newState.guild.id,
        userId: newState.id,
        message: 'voiceStateUpdate handler failed',
        err: toError(err),
      });
    });
  });
}

async function handle(oldState: VoiceState, newState: VoiceState, ctx: BotContext): Promise<void> {
  const guildId = newState.guild.id;
  const userId = newState.id;

  if (userId === ctx.client.user?.id) {
    await handleSelfMoved(oldState, newState, ctx);
    return;
  }

  const session = ctx.voice.getSession(guildId);
  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;

  // Left, or moved away from, the channel we are monitoring.
  if (session && oldChannelId === session.channelId && newChannelId !== oldChannelId) {
    // Flush by default: someone who leaves mid-sentence should still be
    // moderated for what they said before going.
    await session.releaseUser(userId, { flush: true });
  }

  // Muted or deafened in our channel: no further audio will arrive, so close
  // out whatever is buffered rather than leaving it to age out.
  if (session && newChannelId === session.channelId) {
    const nowSilent = newState.selfMute || newState.serverMute;
    const wasSilent = oldState.selfMute || oldState.serverMute;
    if (nowSilent && !wasSilent) {
      await session.releaseUser(userId, { flush: true });
    }
  }

  if (newChannelId && newChannelId !== oldChannelId) {
    await maybeAutoJoin(newState, ctx);
  }

  if (oldChannelId && oldChannelId !== newChannelId) {
    await maybeAutoLeave(oldState, ctx);
  }
}

/** The bot itself was moved or disconnected by someone with permission. */
async function handleSelfMoved(
  oldState: VoiceState,
  newState: VoiceState,
  ctx: BotContext,
): Promise<void> {
  const guildId = newState.guild.id;
  const session = ctx.voice.getSession(guildId);
  if (!session) return;

  if (!newState.channelId) {
    ctx.logger.info(LogEvent.VOICE_LEFT, {
      guildId,
      channelId: oldState.channelId,
      message: 'Bot was disconnected from voice',
    });
    await ctx.voice.leave(guildId);
    return;
  }

  if (newState.channelId !== session.channelId) {
    // Being dragged into a channel is not consent from the people in it, so
    // the bot leaves rather than silently monitoring somewhere new.
    ctx.logger.warn(LogEvent.VOICE_LEFT, {
      guildId,
      from: session.channelId,
      to: newState.channelId,
      message: 'Bot was moved to a channel it was not asked to monitor; leaving',
    });
    await ctx.voice.leave(guildId);
  }
}

async function maybeAutoJoin(state: VoiceState, ctx: BotContext): Promise<void> {
  if (!ctx.config.discord.autoJoin) return;
  if (state.member?.user.bot) return;

  const channel = state.channel;
  if (!channel || channel.type !== ChannelType.GuildVoice) return;

  const guildId = state.guild.id;
  if (!(await ctx.settings.isMonitored(guildId, channel.id))) return;

  const settings = await ctx.settings.get(guildId);
  if (!settings.moderationEnabled) return;

  const existing = ctx.voice.getSession(guildId);
  if (existing) return; // one voice connection per guild

  const announced = await postMonitoringNotice(channel, ctx.config, ctx.logger);
  if (!announced) return;

  try {
    await ctx.voice.join(channel);
  } catch (err) {
    ctx.logger.error(LogEvent.DISCORD_VOICE_ERROR, {
      guildId,
      channelId: channel.id,
      message: 'Auto-join failed',
      err: toError(err),
    });
  }
}

async function maybeAutoLeave(state: VoiceState, ctx: BotContext): Promise<void> {
  if (!ctx.config.discord.autoLeaveWhenEmpty) return;

  const guildId = state.guild.id;
  const session = ctx.voice.getSession(guildId);
  if (!session || session.channelId !== state.channelId) return;

  const channel = state.channel;
  if (!channel) return;

  const humans = channel.members.filter((member) => !member.user.bot).size;
  if (humans > 0) return;

  ctx.logger.info(LogEvent.VOICE_LEFT, {
    guildId,
    channelId: channel.id,
    message: 'Channel is empty; leaving',
  });
  await ctx.voice.leave(guildId);
}
