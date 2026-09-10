import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import type { VoiceBasedChannel } from 'discord.js';
import type { AppConfig } from '../config/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import { toError } from '../utils/errors.js';

/**
 * How long before the same channel gets the notice again.
 *
 * Auto-join fires whenever someone enters an empty monitored channel, so
 * without this a single person joining and leaving would repost the notice
 * every time. A notice people learn to scroll past has stopped informing
 * anyone, which defeats the whole point of posting it.
 */
const NOTICE_COOLDOWN_MS = 10 * 60 * 1000;

const lastNoticeAt = new Map<string, number>();

/** Exposed for tests. */
export function resetNoticeCooldowns(): void {
  lastNoticeAt.clear();
}

/**
 * Tell people in the channel that their speech is being transcribed.
 *
 * This is not decoration. Recording or processing a conversation without
 * telling the participants is unlawful in a number of jurisdictions
 * regardless of who owns the server, and Discord now tells users their voice
 * calls are end-to-end encrypted — which makes an unannounced transcription
 * bot actively contrary to what they have been led to expect.
 *
 * Returns false when the notice could not be delivered. The caller treats that
 * as a reason not to join, rather than listening silently.
 */
export async function postMonitoringNotice(
  channel: VoiceBasedChannel,
  config: AppConfig,
  logger: Logger,
  opts: { force?: boolean; now?: number } = {},
): Promise<boolean> {
  if (!config.privacy.requireMonitoringNotice) return true;

  const now = opts.now ?? Date.now();
  const previous = lastNoticeAt.get(channel.id);
  if (!opts.force && previous !== undefined && now - previous < NOTICE_COOLDOWN_MS) {
    // Recently announced. Permission was proven at that point, so joining is
    // still consistent with having informed the channel.
    return true;
  }

  const me = channel.guild.members.me;
  if (!me || !channel.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages)) {
    logger.error(LogEvent.PERMISSION_ERROR, {
      guildId: channel.guild.id,
      channelId: channel.id,
      message:
        'Cannot post the monitoring notice (missing Send Messages); refusing to monitor this channel. ' +
        'Grant the permission, or set REQUIRE_MONITORING_NOTICE=false only if you have another ' +
        'means of informing participants.',
    });
    return false;
  }

  const lines = [
    'Voice in this channel is being **transcribed automatically** to check for terms this server prohibits.',
    '',
    `• Audio is processed in memory${config.evidence.enabled ? '' : ' and is not recorded'}.`,
    config.evidence.enabled
      ? `• When a rule is triggered, a short clip of **that speaker only** is retained for ${config.evidence.retentionDays} day(s) as moderation evidence.`
      : '• No recordings are kept.',
    config.privacy.transcriptLogging
      ? '• Transcripts are stored in the moderation log.'
      : '• Transcripts are not stored; only a non-reversible hash is kept.',
    `• Transcription is performed by: **${config.stt.provider}**.`,
    '',
    'If you do not consent to this, please leave the channel.',
  ];

  const embed = new EmbedBuilder()
    .setTitle('🎙️ This voice channel is monitored')
    .setDescription(lines.join('\n'))
    .setColor(0xf1c40f);

  try {
    await channel.send({ embeds: [embed] });
    lastNoticeAt.set(channel.id, now);
    return true;
  } catch (err) {
    logger.error(LogEvent.PERMISSION_ERROR, {
      guildId: channel.guild.id,
      channelId: channel.id,
      message: 'Failed to post the monitoring notice; refusing to monitor this channel',
      err: toError(err),
    });
    return false;
  }
}
