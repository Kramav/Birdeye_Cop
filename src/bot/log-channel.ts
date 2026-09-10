import { EmbedBuilder } from 'discord.js';
import type { Client, TextBasedChannel } from 'discord.js';
import type { AppConfig } from '../config/types.js';
import type { ModerationEventContext } from '../moderation/pipeline.js';
import type { Severity } from '../moderation/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import type { ModerationEvent } from '../storage/types.js';
import { toError } from '../utils/errors.js';

const SEVERITY_COLOR: Record<Severity, number> = {
  low: 0x3498db,
  medium: 0xe67e22,
  high: 0xe74c3c,
};

/** Posts moderation activity to the configured log channel. */
export class ModerationReporter {
  private channel: TextBasedChannel | undefined;

  constructor(
    private readonly client: Client,
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  private async resolveChannel(): Promise<TextBasedChannel | undefined> {
    if (this.channel) return this.channel;
    try {
      const channel = await this.client.channels.fetch(this.config.discord.moderationLogChannelId);
      if (channel?.isTextBased()) {
        this.channel = channel;
        return channel;
      }
      this.logger.error(LogEvent.PERMISSION_ERROR, {
        channelId: this.config.discord.moderationLogChannelId,
        message: 'Moderation log channel is not a text channel',
      });
    } catch (err) {
      this.logger.error(LogEvent.PERMISSION_ERROR, {
        channelId: this.config.discord.moderationLogChannelId,
        message: 'Could not resolve the moderation log channel',
        err: toError(err),
      });
    }
    return undefined;
  }

  async report(event: ModerationEvent, context: ModerationEventContext): Promise<void> {
    const channel = await this.resolveChannel();
    if (!channel || !('send' in channel)) return;

    const title = event.dryRun
      ? '🧪 Voice moderation (dry run)'
      : event.actionTaken
        ? '🚨 Voice moderation action'
        : '⚠️ Voice moderation match (no action)';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(SEVERITY_COLOR[event.severity])
      .addFields(
        { name: 'User', value: `<@${event.userId}>\n\`${event.userId}\``, inline: true },
        { name: 'Channel', value: `<#${event.channelId}>`, inline: true },
        { name: 'Action', value: describeAction(event, context), inline: true },
        { name: 'Rule', value: `\`${event.ruleId}\``, inline: true },
        { name: 'Severity', value: event.severity, inline: true },
        {
          name: 'Confidence',
          value: event.confidence === null ? 'not reported' : event.confidence.toFixed(2),
          inline: true,
        },
      )
      .setTimestamp(new Date(event.createdAt))
      .setFooter({ text: `${event.provider} · ${event.model}` });

    if (context.priorViolations > 0) {
      embed.addFields({
        name: 'Prior violations',
        value: String(context.priorViolations),
        inline: true,
      });
    }

    if (context.banWithheld) {
      embed.addFields({
        name: '⚖️ Ban withheld',
        value:
          'Escalation reached `ban`, which was downgraded to `kick` because ' +
          '`ALLOW_UNATTENDED_BAN` is disabled. Review this event and ban manually if warranted.',
      });
    }

    if (event.failureReason) {
      embed.addFields({ name: 'Note', value: `\`${event.failureReason}\`` });
    }

    // Transcripts appear here only when the operator has explicitly enabled
    // transcript logging; otherwise only the hash is available.
    if (event.transcript) {
      embed.addFields({
        name: 'Transcript',
        value: truncate(event.transcript, 1000),
      });
    } else {
      embed.addFields({
        name: 'Transcript',
        value: `_not logged_ (hash \`${event.transcriptHash}\`)`,
      });
    }

    if (context.evidence) {
      embed.addFields({
        name: 'Evidence',
        value:
          `\`${context.evidence.id}\`\n` +
          `${Math.round(context.evidence.durationMs)}ms · retrieve with \`/moderation evidence\``,
      });
    }

    try {
      await channel.send({ embeds: [embed] });
    } catch (err) {
      this.logger.error(LogEvent.PERMISSION_ERROR, {
        message: 'Failed to post to the moderation log channel',
        err: toError(err),
      });
    }
  }

  /** Posted once on startup so operators can see the active configuration. */
  async postStartupSummary(fields: Record<string, string>): Promise<void> {
    const channel = await this.resolveChannel();
    if (!channel || !('send' in channel)) return;

    const embed = new EmbedBuilder()
      .setTitle('🟢 Voice moderation online')
      .setColor(0x2ecc71)
      .addFields(
        Object.entries(fields).map(([name, value]) => ({ name, value: `\`${value}\``, inline: true })),
      )
      .setTimestamp(new Date());

    try {
      await channel.send({ embeds: [embed] });
    } catch (err) {
      this.logger.warn(LogEvent.PERMISSION_ERROR, {
        message: 'Could not post the startup summary',
        err: toError(err),
      });
    }
  }

  /** Surfaces degraded operation so silence is never mistaken for compliance. */
  async postAlert(title: string, description: string): Promise<void> {
    const channel = await this.resolveChannel();
    if (!channel || !('send' in channel)) return;

    try {
      await channel.send({
        embeds: [new EmbedBuilder().setTitle(title).setDescription(description).setColor(0xe74c3c)],
      });
    } catch {
      // Already logged elsewhere; never throw from a reporting path.
    }
  }
}

function describeAction(event: ModerationEvent, context: ModerationEventContext): string {
  if (event.dryRun) return `\`${event.action}\` (dry run — not applied)`;
  if (event.actionTaken) return `\`${event.action}\``;
  return `\`${event.action}\` — not applied (${context.actionSkipped ?? event.failureReason ?? 'unknown'})`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
