import {
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import type { ChatInputCommandInteraction, GuildMember, VoiceBasedChannel } from 'discord.js';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { assertSafeEvidenceId, assertWithinDirectory } from '../../evidence/paths.js';
import { ACTION_LADDER } from '../../moderation/types.js';
import type { ModerationActionType, Severity } from '../../moderation/types.js';
import { LogEvent } from '../../observability/events.js';
import { UnsafePathError, toError } from '../../utils/errors.js';
import type { BotContext } from '../context.js';
import { postMonitoringNotice } from '../notice.js';
import { requireAdmin } from './guards.js';

export const moderationCommand = new SlashCommandBuilder()
  .setName('moderation')
  .setDescription('Configure and inspect voice moderation')
  // A UI hint only — authorization is re-checked at execution time in guards.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .setContexts(InteractionContextType.Guild)
  .addSubcommand((s) => s.setName('status').setDescription('Show the current moderation settings'))
  .addSubcommand((s) => s.setName('enable').setDescription('Enable voice moderation'))
  .addSubcommand((s) => s.setName('disable').setDescription('Disable voice moderation'))
  .addSubcommand((s) =>
    s
      .setName('action')
      .setDescription('Set the most severe action moderation may take')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('Maximum action')
          .setRequired(true)
          .addChoices(
            { name: 'warn', value: 'warn' },
            { name: 'disconnect', value: 'disconnect' },
            { name: 'kick', value: 'kick' },
            { name: 'ban', value: 'ban' },
          ),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('dry-run')
      .setDescription('Log violations without acting on them')
      .addBooleanOption((o) =>
        o.setName('enabled').setDescription('Whether dry-run is on').setRequired(true),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('add')
      .setDescription('Ban a word or phrase — applies immediately, no restart')
      .addStringOption((o) =>
        o
          .setName('term')
          .setDescription('One word, or a phrase with spaces. Case and punctuation are ignored.')
          .setRequired(true)
          .setMaxLength(200),
      )
      .addStringOption((o) =>
        o
          .setName('severity')
          .setDescription('high = harsher first action. Default: medium')
          .addChoices(
            { name: 'low', value: 'low' },
            { name: 'medium', value: 'medium' },
            { name: 'high', value: 'high' },
          ),
      )
      .addBooleanOption((o) =>
        o
          .setName('whole-word')
          .setDescription('Default true: "cat" will not match "category". False matches inside words.'),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('remove')
      .setDescription('Remove a banned word, phrase, or rule ID')
      .addStringOption((o) =>
        o.setName('term').setDescription('Term or rule ID').setRequired(true).setMaxLength(200),
      ),
  )
  .addSubcommand((s) => s.setName('list').setDescription('List the configured rules'))
  .addSubcommand((s) =>
    s
      .setName('join')
      .setDescription('Monitor a voice channel')
      .addChannelOption((o) =>
        o
          .setName('channel')
          .setDescription('Voice channel (defaults to yours)')
          .addChannelTypes(ChannelType.GuildVoice),
      ),
  )
  .addSubcommand((s) => s.setName('leave').setDescription('Stop monitoring and leave voice'))
  .addSubcommand((s) =>
    s
      .setName('evidence')
      .setDescription('Show a violation evidence record')
      .addStringOption((o) =>
        o.setName('id').setDescription('Evidence ID').setRequired(true).setMaxLength(64),
      ),
  )
  .addSubcommand((s) =>
    s
      .setName('evidence-list')
      .setDescription('List recent evidence records')
      .addUserOption((o) => o.setName('user').setDescription('Filter by user')),
  )
  .addSubcommand((s) =>
    s
      .setName('evidence-delete')
      .setDescription('Permanently delete an evidence record and its audio')
      .addStringOption((o) =>
        o.setName('id').setDescription('Evidence ID').setRequired(true).setMaxLength(64),
      ),
  );

export async function handleModerationCommand(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  if (!(await requireAdmin(interaction, ctx.config, ctx.logger))) return;

  const subcommand = interaction.options.getSubcommand(true);
  const guildId = interaction.guildId!;

  ctx.logger.info(LogEvent.COMMAND_INVOKED, {
    guildId,
    userId: interaction.user.id,
    command: 'moderation',
    subcommand,
  });

  switch (subcommand) {
    case 'status':
      return status(interaction, ctx, guildId);
    case 'enable':
      return setEnabled(interaction, ctx, guildId, true);
    case 'disable':
      return setEnabled(interaction, ctx, guildId, false);
    case 'action':
      return setAction(interaction, ctx, guildId);
    case 'dry-run':
      return setDryRun(interaction, ctx, guildId);
    case 'add':
      return addRule(interaction, ctx);
    case 'remove':
      return removeRule(interaction, ctx);
    case 'list':
      return listRules(interaction, ctx);
    case 'join':
      return join(interaction, ctx, guildId);
    case 'leave':
      return leave(interaction, ctx, guildId);
    case 'evidence':
      return showEvidence(interaction, ctx, guildId);
    case 'evidence-list':
      return listEvidence(interaction, ctx, guildId);
    case 'evidence-delete':
      return deleteEvidence(interaction, ctx, guildId);
    default:
      await interaction.reply({
        content: `Unknown subcommand: ${subcommand}`,
        flags: MessageFlags.Ephemeral,
      });
  }
}

// -- settings --------------------------------------------------------------

async function status(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  guildId: string,
): Promise<void> {
  const settings = await ctx.settings.get(guildId);
  const session = ctx.voice.getSession(guildId);

  const embed = new EmbedBuilder()
    .setTitle('Voice moderation status')
    .setColor(settings.moderationEnabled ? 0x2ecc71 : 0x95a5a6)
    .addFields(
      { name: 'Enabled', value: settings.moderationEnabled ? 'yes' : 'no', inline: true },
      { name: 'Dry run', value: settings.dryRun ? 'yes' : 'no', inline: true },
      { name: 'Max action', value: `\`${settings.actionCeiling}\``, inline: true },
      { name: 'Rules', value: String(ctx.rules.ruleCount), inline: true },
      {
        name: 'Speech-to-text',
        value: `\`${ctx.config.stt.provider}\` · \`${ctx.config.stt.model}\``,
        inline: true,
      },
      {
        name: 'Verify model',
        value: ctx.config.stt.weakVerify
          ? `\`${ctx.config.stt.verifyModel}\` ⚠️ same as primary`
          : `\`${ctx.config.stt.verifyModel}\``,
        inline: true,
      },
      {
        name: 'Monitored channels',
        value:
          settings.monitoredChannelIds.length > 0
            ? settings.monitoredChannelIds.map((id) => `<#${id}>`).join(', ')
            : '_none — use `/moderation join`_',
      },
      {
        name: 'Currently in',
        value: session ? `<#${session.channelId}> (${session.activeSpeakers} tracked)` : '_not connected_',
      },
      {
        name: 'Privacy',
        value: [
          `Transcript logging: \`${ctx.config.privacy.transcriptLogging}\``,
          `Violation audio: \`${ctx.config.evidence.enabled}\``,
          `Monitoring notice: \`${ctx.config.privacy.requireMonitoringNotice}\``,
        ].join('\n'),
      },
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function setEnabled(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  guildId: string,
  enabled: boolean,
): Promise<void> {
  await ctx.settings.update(guildId, { moderationEnabled: enabled });
  ctx.logger.info(LogEvent.CONFIG_CHANGED, {
    guildId,
    userId: interaction.user.id,
    change: 'moderation-enabled',
    value: enabled,
  });
  await interaction.reply({
    content: `Voice moderation is now **${enabled ? 'enabled' : 'disabled'}**.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function setAction(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  guildId: string,
): Promise<void> {
  const action = interaction.options.getString('action', true) as ModerationActionType;
  if (!ACTION_LADDER.includes(action)) {
    await interaction.reply({ content: 'Unknown action.', flags: MessageFlags.Ephemeral });
    return;
  }

  await ctx.settings.update(guildId, { actionCeiling: action });
  ctx.logger.info(LogEvent.CONFIG_CHANGED, {
    guildId,
    userId: interaction.user.id,
    change: 'action-ceiling',
    value: action,
  });

  const notes: string[] = [`Maximum moderation action is now **${action}**.`];

  if (action === 'ban' && !ctx.config.moderation.allowUnattendedBan) {
    // Deliberately loud: an operator setting the ceiling to `ban` should not
    // be left believing bans will happen when they will not.
    notes.push(
      '',
      '⚠️ `ALLOW_UNATTENDED_BAN` is **false**, so escalation to `ban` will be **downgraded to `kick`** ' +
        'and flagged for human review. Automated permanent bans decided by a speech recognizer are ' +
        'off by default because transcription of noisy voice chat is not reliable enough for an ' +
        'irreversible action. Set `ALLOW_UNATTENDED_BAN=true` to change that.',
    );
  }

  await interaction.reply({ content: notes.join('\n'), flags: MessageFlags.Ephemeral });
}

async function setDryRun(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  guildId: string,
): Promise<void> {
  const enabled = interaction.options.getBoolean('enabled', true);
  await ctx.settings.update(guildId, { dryRun: enabled });
  ctx.logger.info(LogEvent.CONFIG_CHANGED, {
    guildId,
    userId: interaction.user.id,
    change: 'dry-run',
    value: enabled,
  });
  await interaction.reply({
    content: enabled
      ? 'Dry run **on** — violations will be logged but no action taken.'
      : 'Dry run **off** — moderation actions will now be applied.',
    flags: MessageFlags.Ephemeral,
  });
}

// -- rules -----------------------------------------------------------------

async function addRule(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const term = interaction.options.getString('term', true);
  const severity = (interaction.options.getString('severity') ?? 'medium') as Severity;
  const wholeWord = interaction.options.getBoolean('whole-word') ?? true;

  try {
    const { rule, alreadyExists } = await ctx.rules.addTerm(term, { severity, wholeWord });
    await interaction.reply({
      content: alreadyExists
        ? `That term is already covered by rule \`${rule.id}\`.`
        : `Added rule \`${rule.id}\` (${rule.type}, ${rule.severity}, whole-word: ${rule.wholeWord}). ` +
          `It is active now in monitored channels.\n` +
          `Undo: \`/moderation remove term:${rule.id}\` · See all: \`/moderation list\``,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    await interaction.reply({
      content: `Could not add that term: ${toError(err).message}`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function removeRule(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const term = interaction.options.getString('term', true);
  const removed = await ctx.rules.removeTerm(term);
  await interaction.reply({
    content: removed
      ? `Removed rule \`${removed.id}\`.`
      : 'No matching rule found. Use `/moderation list` to see rule IDs.',
    flags: MessageFlags.Ephemeral,
  });
}

async function listRules(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
): Promise<void> {
  const { rules, allowlist } = ctx.rules.current;

  if (rules.length === 0) {
    await interaction.reply({
      content: 'No banned words yet. Add one with `/moderation add term:<word or phrase>`.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = rules.map((rule) => {
    const flags = [
      rule.type,
      rule.severity,
      rule.wholeWord ? 'whole-word' : 'substring',
      rule.enabled ? 'enabled' : 'disabled',
      rule.action ? `action:${rule.action}` : undefined,
      rule.exceptions.length ? `${rule.exceptions.length} exception(s)` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    return `\`${rule.id}\` — ${flags}`;
  });

  if (allowlist.length > 0) {
    lines.push('', `**Allowlist:** ${allowlist.length} term(s)`);
  }
  if (rules.some((rule) => rule.id.startsWith('example-'))) {
    lines.push('', '`example-*` rules are placeholders from the example file. Remove them with `/moderation remove`.');
  }
  lines.push('', 'Add: `/moderation add term:<word>` · Remove: `/moderation remove term:<rule ID or word>`');

  // The rules themselves are not echoed back: the list is a management view,
  // and repeating every banned term into a channel is rarely what an admin
  // wants. Rule IDs are enough to remove or edit them.
  const body = lines.join('\n');
  await interaction.reply({
    content: body.length > 1900 ? `${body.slice(0, 1900)}\n… (truncated)` : body,
    flags: MessageFlags.Ephemeral,
  });
}

// -- voice -----------------------------------------------------------------

async function join(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const optionChannel = interaction.options.getChannel('channel');
  const memberChannel = (interaction.member as GuildMember | null)?.voice?.channel ?? null;
  const channel = (optionChannel ?? memberChannel) as VoiceBasedChannel | null;

  if (!channel || !('guild' in channel)) {
    await interaction.editReply(
      'Join a voice channel first, or pass one with the `channel` option.',
    );
    return;
  }

  // Announce before listening. If the notice cannot be delivered, do not
  // listen at all. Forced: an admin explicitly starting monitoring should
  // always produce a visible announcement, cooldown or not.
  const announced = await postMonitoringNotice(channel, ctx.config, ctx.logger, { force: true });
  if (!announced) {
    await interaction.editReply(
      'I could not post the monitoring notice in that channel, so I have not joined. ' +
        'Grant me **Send Messages** there and try again.',
    );
    return;
  }

  try {
    await ctx.voice.join(channel);
    await ctx.settings.addMonitoredChannel(guildId, channel.id);
    ctx.logger.info(LogEvent.CONFIG_CHANGED, {
      guildId,
      userId: interaction.user.id,
      change: 'monitored-channel-added',
      channelId: channel.id,
    });
    await interaction.editReply(`Now monitoring <#${channel.id}>.`);
  } catch (err) {
    ctx.logger.error(LogEvent.DISCORD_VOICE_ERROR, {
      guildId,
      channelId: channel.id,
      err: toError(err),
    });
    await interaction.editReply(`Could not join that channel: ${toError(err).message}`);
  }
}

async function leave(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const session = ctx.voice.getSession(guildId);
  if (session) {
    await ctx.settings.removeMonitoredChannel(guildId, session.channelId);
  }
  await ctx.voice.leave(guildId);

  await interaction.editReply(
    session ? `Left <#${session.channelId}> and stopped monitoring it.` : 'I am not in a voice channel.',
  );
}

// -- evidence --------------------------------------------------------------

async function showEvidence(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rawId = interaction.options.getString('id', true);

  let record;
  try {
    assertSafeEvidenceId(rawId);
    record = await ctx.store.getEvidence(rawId);
  } catch (err) {
    if (err instanceof UnsafePathError) {
      await interaction.editReply('That is not a valid evidence ID.');
      return;
    }
    throw err;
  }

  // Scope to the invoking guild so an admin in one server cannot read another
  // server's evidence by guessing an ID.
  if (!record || record.guildId !== guildId) {
    await interaction.editReply('No evidence found with that ID.');
    return;
  }

  ctx.logger.info(LogEvent.EVIDENCE_ACCESSED, {
    guildId,
    evidenceId: record.id,
    requestedBy: interaction.user.id,
  });

  const embed = new EmbedBuilder()
    .setTitle('Violation evidence')
    .setColor(0xe67e22)
    .addFields(
      { name: 'Evidence ID', value: `\`${record.id}\`` },
      { name: 'User', value: `<@${record.userId}>\n\`${record.userId}\``, inline: true },
      { name: 'Channel', value: `<#${record.channelId}>`, inline: true },
      { name: 'Rule', value: `\`${record.ruleId}\``, inline: true },
      { name: 'Action', value: `\`${record.action}\``, inline: true },
      { name: 'Duration', value: `${record.durationMs}ms`, inline: true },
      { name: 'Size', value: `${(record.byteSize / 1024).toFixed(1)} KiB`, inline: true },
      { name: 'Recorded', value: `<t:${Math.floor(record.createdAt / 1000)}:F>` },
      { name: 'Expires', value: `<t:${Math.floor(record.expiresAt / 1000)}:R>` },
    );

  if (record.transcript) {
    embed.addFields({ name: 'Transcript', value: record.transcript.slice(0, 1000) });
  }

  const files: AttachmentBuilder[] = [];
  if (ctx.config.evidence.allowDiscordUpload) {
    try {
      const path = assertWithinDirectory(ctx.config.evidence.directory, record.filePath);
      await access(path, constants.R_OK);
      files.push(new AttachmentBuilder(path, { name: record.filename }));
    } catch (err) {
      embed.addFields({ name: 'Audio', value: '_file unavailable_' });
      ctx.logger.warn(LogEvent.EVIDENCE_ERROR, {
        evidenceId: record.id,
        message: 'Evidence audio could not be attached',
        err: toError(err),
      });
    }
  } else {
    embed.addFields({
      name: 'Audio',
      value:
        '_Not attached._ `EVIDENCE_ALLOW_DISCORD_UPLOAD` is disabled, because uploading places the ' +
        "recording on Discord's CDN. The file is on the bot host at the configured evidence directory.",
    });
  }

  await interaction.editReply({ embeds: [embed], files });
}

async function listEvidence(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = interaction.options.getUser('user');
  const records = await ctx.store.listEvidence({
    guildId,
    ...(user ? { userId: user.id } : {}),
    limit: 20,
  });

  if (records.length === 0) {
    await interaction.editReply('No evidence records found.');
    return;
  }

  const lines = records.map(
    (r) =>
      `\`${r.id}\` · <@${r.userId}> · \`${r.ruleId}\` · <t:${Math.floor(r.createdAt / 1000)}:R> · expires <t:${Math.floor(r.expiresAt / 1000)}:R>`,
  );

  await interaction.editReply({
    content: lines.join('\n').slice(0, 1900),
    allowedMentions: { parse: [] },
  });
}

async function deleteEvidence(
  interaction: ChatInputCommandInteraction,
  ctx: BotContext,
  guildId: string,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const rawId = interaction.options.getString('id', true);

  try {
    assertSafeEvidenceId(rawId);
  } catch {
    await interaction.editReply('That is not a valid evidence ID.');
    return;
  }

  const record = await ctx.store.getEvidence(rawId);
  if (!record || record.guildId !== guildId) {
    await interaction.editReply('No evidence found with that ID.');
    return;
  }

  const deleted = await ctx.sweeper.deleteRecordFile(record);
  if (deleted) {
    ctx.logger.info(LogEvent.EVIDENCE_DELETED, {
      guildId,
      evidenceId: record.id,
      deletedBy: interaction.user.id,
    });
  }

  await interaction.editReply(
    deleted
      ? `Deleted evidence \`${record.id}\` and its audio file.`
      : `Could not fully delete \`${record.id}\`. Check the logs.`,
  );
}
