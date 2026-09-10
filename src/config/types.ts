import type { ModerationActionType } from '../moderation/types.js';
import type { LogLevel } from '../observability/logger.js';

export type SttProviderName = 'mock' | 'openai' | 'deepgram';
export type StorageDriver = 'auto' | 'sqlite' | 'jsonl' | 'memory';

export interface DiscordConfig {
  token: string;
  clientId: string;
  /** Empty means "every guild the bot is in". */
  guildIds: string[];
  /** Seed list; `/moderation join` adds more at runtime. */
  monitoredVoiceChannelIds: string[];
  moderationLogChannelId: string;
  moderatorRoleId?: string;
  autoJoin: boolean;
  autoLeaveWhenEmpty: boolean;
}

export interface VoiceConfig {
  /** Silence duration that ends a receive subscription. */
  vadSilenceMs: number;
  /** Grace window for re-attaching a prematurely cut stream (discord.js#8105). */
  segmentCoalesceMs: number;
  minSpeechMs: number;
  maxSegmentMs: number;
  /** Normalized RMS (0..1) below which audio counts as silence. */
  vadEnergyThreshold: number;
  /** Transmit a silence frame after joining to open the receive path. */
  silenceKeepalive: boolean;
  /** Alert if a channel has speakers but yields no PCM for this long. */
  livenessTimeoutMs: number;
}

export interface SttConfig {
  provider: SttProviderName;
  apiKey?: string;
  baseUrl?: string;
  model: string;
  language?: string;
  verifyProvider: SttProviderName;
  verifyModel: string;
  /**
   * True when primary and verify resolve to the same provider+model, which
   * makes the second pass much weaker evidence. Logged loudly at startup.
   */
  weakVerify: boolean;
  maxConcurrency: number;
  timeoutMs: number;
  queueMax: number;
  breakerThreshold: number;
  breakerResetMs: number;
}

export interface ModerationConfig {
  enabled: boolean;
  /** Most severe action permitted; per-rule actions are capped to it. */
  actionCeiling: ModerationActionType;
  allowUnattendedBan: boolean;
  escalationEnabled: boolean;
  escalationWindowHours: number;
  dryRun: boolean;
  confidenceThreshold: number;
  dedupeTtlMs: number;
  rulesPath: string;
}

export interface PrivacyConfig {
  requireMonitoringNotice: boolean;
  transcriptLogging: boolean;
}

export interface EvidenceConfig {
  enabled: boolean;
  directory: string;
  retentionDays: number;
  prebufferMs: number;
  postbufferMs: number;
  /** Delay the action by `postbufferMs` so real trailing audio is captured. */
  delayAction: boolean;
  allowDiscordUpload: boolean;
  biometricRiskAcknowledged: boolean;
}

export interface StorageConfig {
  driver: StorageDriver;
  databasePath: string;
  moderationLogRetentionDays: number;
  retentionSweepIntervalMs: number;
}

export interface OpsConfig {
  logLevel: LogLevel;
  logPretty: boolean;
  strictPermissions: boolean;
}

export interface AppConfig {
  discord: DiscordConfig;
  voice: VoiceConfig;
  stt: SttConfig;
  moderation: ModerationConfig;
  privacy: PrivacyConfig;
  evidence: EvidenceConfig;
  storage: StorageConfig;
  ops: OpsConfig;
}
