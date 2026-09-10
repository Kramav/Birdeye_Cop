import type { AppConfig } from '../config/types.js';
import type { ModerationActionType } from '../moderation/types.js';
import type { ModerationStore } from './types.js';

export interface EffectiveGuildSettings {
  moderationEnabled: boolean;
  actionCeiling: ModerationActionType;
  dryRun: boolean;
  monitoredChannelIds: string[];
}

/**
 * Merges environment defaults with per-guild overrides made through commands.
 *
 * Runtime changes are persisted rather than held in memory, so a moderator
 * turning the bot off or switching it to dry-run is not silently undone by the
 * next restart.
 */
export class GuildSettingsService {
  private readonly cache = new Map<string, EffectiveGuildSettings>();

  constructor(
    private readonly store: ModerationStore,
    private readonly config: AppConfig,
  ) {}

  private defaults(): EffectiveGuildSettings {
    return {
      moderationEnabled: this.config.moderation.enabled,
      actionCeiling: this.config.moderation.actionCeiling,
      dryRun: this.config.moderation.dryRun,
      monitoredChannelIds: [...this.config.discord.monitoredVoiceChannelIds],
    };
  }

  async get(guildId: string): Promise<EffectiveGuildSettings> {
    const cached = this.cache.get(guildId);
    if (cached) return cached;

    const stored = await this.store.getGuildSettings(guildId);
    const defaults = this.defaults();

    const effective: EffectiveGuildSettings = {
      moderationEnabled: stored?.moderationEnabled ?? defaults.moderationEnabled,
      actionCeiling: stored?.actionCeiling ?? defaults.actionCeiling,
      dryRun: stored?.dryRun ?? defaults.dryRun,
      // Env-configured channels are always monitored; commands add to that set
      // rather than replacing it.
      monitoredChannelIds: unique([
        ...defaults.monitoredChannelIds,
        ...(stored?.monitoredChannelIds ?? []),
      ]),
    };

    this.cache.set(guildId, effective);
    return effective;
  }

  async update(
    guildId: string,
    patch: Partial<Omit<EffectiveGuildSettings, 'monitoredChannelIds'>>,
  ): Promise<EffectiveGuildSettings> {
    await this.store.setGuildSettings(guildId, patch);
    this.cache.delete(guildId);
    return this.get(guildId);
  }

  async addMonitoredChannel(guildId: string, channelId: string): Promise<EffectiveGuildSettings> {
    const stored = await this.store.getGuildSettings(guildId);
    const next = unique([...(stored?.monitoredChannelIds ?? []), channelId]);
    await this.store.setGuildSettings(guildId, { monitoredChannelIds: next });
    this.cache.delete(guildId);
    return this.get(guildId);
  }

  async removeMonitoredChannel(
    guildId: string,
    channelId: string,
  ): Promise<EffectiveGuildSettings> {
    const stored = await this.store.getGuildSettings(guildId);
    const next = (stored?.monitoredChannelIds ?? []).filter((id) => id !== channelId);
    await this.store.setGuildSettings(guildId, { monitoredChannelIds: next });
    this.cache.delete(guildId);
    return this.get(guildId);
  }

  /**
   * Whether a channel is opted in to monitoring.
   *
   * An empty list means nothing is monitored. There is deliberately no
   * "monitor everything" default: people should not be transcribed because an
   * operator forgot to narrow a setting.
   */
  async isMonitored(guildId: string, channelId: string): Promise<boolean> {
    const settings = await this.get(guildId);
    return settings.monitoredChannelIds.includes(channelId);
  }

  invalidate(guildId?: string): void {
    if (guildId) this.cache.delete(guildId);
    else this.cache.clear();
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
