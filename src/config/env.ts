import { config as loadDotenv } from 'dotenv';
import { ConfigError } from '../utils/errors.js';
import type { LogLevel } from '../observability/logger.js';
import type { ModerationActionType } from '../moderation/types.js';
import { ACTION_LADDER } from '../moderation/types.js';
import type { AppConfig, SttProviderName, StorageDriver } from './types.js';

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Collects every configuration problem before throwing, so an operator fixes
 * their whole `.env` in one pass instead of one variable per restart.
 */
class EnvReader {
  private readonly problems: string[] = [];

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  private raw(key: string): string | undefined {
    const v = this.env[key];
    if (v === undefined) return undefined;
    const trimmed = v.trim();
    return trimmed === '' ? undefined : trimmed;
  }

  problem(message: string): void {
    this.problems.push(message);
  }

  str(key: string, opts: { required?: boolean; default?: string } = {}): string {
    const v = this.raw(key);
    if (v === undefined) {
      if (opts.required) {
        this.problems.push(`${key} is required but not set`);
        return '';
      }
      return opts.default ?? '';
    }
    return v;
  }

  optionalStr(key: string): string | undefined {
    return this.raw(key);
  }

  bool(key: string, def: boolean): boolean {
    const v = this.raw(key);
    if (v === undefined) return def;
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off)$/i.test(v)) return false;
    this.problems.push(`${key} must be true or false, got "${v}"`);
    return def;
  }

  num(key: string, def: number, opts: { min?: number; max?: number; int?: boolean } = {}): number {
    const v = this.raw(key);
    if (v === undefined) return def;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      this.problems.push(`${key} must be a number, got "${v}"`);
      return def;
    }
    if (opts.int && !Number.isInteger(n)) {
      this.problems.push(`${key} must be a whole number, got "${v}"`);
      return def;
    }
    if (opts.min !== undefined && n < opts.min) {
      this.problems.push(`${key} must be >= ${opts.min}, got ${n}`);
      return def;
    }
    if (opts.max !== undefined && n > opts.max) {
      this.problems.push(`${key} must be <= ${opts.max}, got ${n}`);
      return def;
    }
    return n;
  }

  snowflake(key: string, opts: { required?: boolean } = {}): string {
    const v = this.raw(key);
    if (v === undefined) {
      if (opts.required) this.problems.push(`${key} is required but not set`);
      return '';
    }
    if (!SNOWFLAKE.test(v)) {
      this.problems.push(
        `${key} must be a Discord ID (17-20 digits), got "${v}". ` +
          `Enable Developer Mode in Discord, then right-click the channel or server and "Copy ID".`,
      );
      return '';
    }
    return v;
  }

  snowflakeList(key: string): string[] {
    const v = this.raw(key);
    if (v === undefined) return [];
    const parts = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const bad = parts.filter((p) => !SNOWFLAKE.test(p));
    if (bad.length) {
      this.problems.push(`${key} contains invalid Discord IDs: ${bad.join(', ')}`);
    }
    return parts.filter((p) => SNOWFLAKE.test(p));
  }

  enum<T extends string>(key: string, allowed: readonly T[], def: T): T {
    const v = this.raw(key);
    if (v === undefined) return def;
    const lowered = v.toLowerCase() as T;
    if (!allowed.includes(lowered)) {
      this.problems.push(`${key} must be one of ${allowed.join(' | ')}, got "${v}"`);
      return def;
    }
    return lowered;
  }

  finish(): void {
    if (this.problems.length > 0) {
      throw new ConfigError(
        `Configuration is invalid:\n${this.problems.map((p) => `  - ${p}`).join('\n')}\n\n` +
          `Run \`npm run setup\` to generate a valid .env, or \`npm run doctor\` to diagnose.`,
      );
    }
  }
}

const STT_PROVIDERS: readonly SttProviderName[] = ['mock', 'openai', 'deepgram'];
const STORAGE_DRIVERS: readonly StorageDriver[] = ['auto', 'sqlite', 'jsonl', 'memory'];
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const DEFAULT_MODELS: Record<SttProviderName, string> = {
  mock: 'mock-1',
  openai: 'gpt-4o-mini-transcribe',
  deepgram: 'nova-3',
};

/**
 * Second-pass model for low-confidence matches.
 *
 * Re-running identical audio through the identical model reproduces the same
 * systematic error, so "both passes agreed" would prove almost nothing. This
 * table picks a genuinely different set of weights wherever one exists.
 */
const VERIFY_MODEL_TABLE: Record<string, string> = {
  'gpt-4o-mini-transcribe': 'gpt-4o-transcribe',
  'whisper-1': 'gpt-4o-transcribe',
  'nova-3': 'nova-2',
  'nova-2': 'nova-3',
  'tiny.en': 'base.en',
  tiny: 'base',
  'base.en': 'small.en',
  base: 'small',
  'small.en': 'medium.en',
  small: 'medium',
};

function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Concurrency is a property of the provider, not a global.
 *
 * A local Whisper server is GPU-bound and serializes; throttling to 1-2 keeps
 * the queue honest. Cloud providers are network-bound and throttling them to
 * the same number just manufactures a bottleneck under cross-talk.
 */
export function defaultConcurrency(provider: SttProviderName, baseUrl?: string): number {
  if (provider === 'mock') return 8;
  if (provider === 'openai' && isLocalUrl(baseUrl)) return 2;
  return 8;
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env, useDotenv = true): AppConfig {
  if (useDotenv) loadDotenv({ quiet: true });
  const r = new EnvReader(env);

  // ---- Discord -----------------------------------------------------------
  const token = r.str('DISCORD_TOKEN', { required: true });
  const clientId = r.snowflake('DISCORD_CLIENT_ID', { required: true });
  const moderationLogChannelId = r.snowflake('MODERATION_LOG_CHANNEL_ID', { required: true });
  const moderatorRoleId = r.optionalStr('MODERATOR_ROLE_ID');
  if (moderatorRoleId !== undefined && !SNOWFLAKE.test(moderatorRoleId)) {
    r.problem(`MODERATOR_ROLE_ID must be a Discord ID (17-20 digits), got "${moderatorRoleId}"`);
  }

  // ---- Speech-to-text ----------------------------------------------------
  const provider = r.enum('STT_PROVIDER', STT_PROVIDERS, 'mock');
  const baseUrl =
    r.optionalStr('STT_BASE_URL') ?? (provider === 'openai' ? 'https://api.openai.com/v1' : undefined);
  const apiKey = r.optionalStr('STT_API_KEY');

  if (provider !== 'mock' && !apiKey) {
    // A local whisper.cpp server needs no key, so only insist when the
    // endpoint is remote.
    if (!(provider === 'openai' && isLocalUrl(baseUrl))) {
      r.problem(
        `STT_API_KEY is required for STT_PROVIDER=${provider}. ` +
          `Use STT_PROVIDER=mock to run without any speech-to-text credentials.`,
      );
    }
  }

  const model = r.str('STT_MODEL', { default: DEFAULT_MODELS[provider] });
  const sttLanguage = r.optionalStr('STT_LANGUAGE');
  const verifyProvider = r.enum('STT_VERIFY_PROVIDER', STT_PROVIDERS, provider);
  const configuredVerifyModel = r.optionalStr('STT_VERIFY_MODEL');
  const verifyModel = configuredVerifyModel ?? VERIFY_MODEL_TABLE[model] ?? model;
  const weakVerify = verifyProvider === provider && verifyModel === model;

  // ---- Evidence ----------------------------------------------------------
  const evidenceEnabled = r.bool('VIOLATION_AUDIO_LOGGING', false);
  const biometricAck = r.bool('I_ACKNOWLEDGE_BIOMETRIC_RISK', false);
  if (evidenceEnabled && !biometricAck) {
    r.problem(
      `VIOLATION_AUDIO_LOGGING=true stores per-person voice recordings, which several ` +
        `jurisdictions treat as biometric data (Illinois BIPA provides statutory damages ` +
        `per violation with no injury required). Set I_ACKNOWLEDGE_BIOMETRIC_RISK=true to ` +
        `confirm you have read docs/PRIVACY.md and the README's legal section.`,
    );
  }

  const config: AppConfig = {
    discord: {
      token,
      clientId,
      guildIds: r.snowflakeList('GUILD_IDS'),
      monitoredVoiceChannelIds: r.snowflakeList('MONITORED_VOICE_CHANNEL_IDS'),
      moderationLogChannelId,
      ...(moderatorRoleId ? { moderatorRoleId } : {}),
      autoJoin: r.bool('AUTO_JOIN', true),
      autoLeaveWhenEmpty: r.bool('AUTO_LEAVE_WHEN_EMPTY', true),
    },
    voice: {
      vadSilenceMs: r.num('VAD_SILENCE_MS', 400, { min: 100, max: 5000, int: true }),
      segmentCoalesceMs: r.num('SEGMENT_COALESCE_MS', 600, { min: 0, max: 5000, int: true }),
      minSpeechMs: r.num('MIN_SPEECH_MS', 300, { min: 50, max: 10_000, int: true }),
      maxSegmentMs: r.num('MAX_SEGMENT_MS', 10_000, { min: 1000, max: 60_000, int: true }),
      vadEnergyThreshold: r.num('VAD_ENERGY_THRESHOLD', 0.02, { min: 0, max: 1 }),
      silenceKeepalive: r.bool('VOICE_SILENCE_KEEPALIVE', true),
      livenessTimeoutMs: r.num('VOICE_LIVENESS_TIMEOUT_MS', 30_000, { min: 5000, int: true }),
    },
    stt: {
      provider,
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      model,
      ...(sttLanguage ? { language: sttLanguage } : {}),
      verifyProvider,
      verifyModel,
      weakVerify,
      maxConcurrency: r.num('STT_MAX_CONCURRENCY', defaultConcurrency(provider, baseUrl), {
        min: 1,
        max: 64,
        int: true,
      }),
      timeoutMs: r.num('STT_TIMEOUT_MS', 8000, { min: 1000, max: 120_000, int: true }),
      queueMax: r.num('STT_QUEUE_MAX', 32, { min: 1, max: 1000, int: true }),
      breakerThreshold: r.num('STT_BREAKER_THRESHOLD', 5, { min: 1, max: 100, int: true }),
      breakerResetMs: r.num('STT_BREAKER_RESET_MS', 30_000, { min: 1000, int: true }),
    },
    moderation: {
      enabled: r.bool('MODERATION_ENABLED', true),
      actionCeiling: r.enum<ModerationActionType>(
        'MODERATION_ACTION',
        ACTION_LADDER,
        'disconnect',
      ),
      allowUnattendedBan: r.bool('ALLOW_UNATTENDED_BAN', false),
      escalationEnabled: r.bool('ESCALATION_ENABLED', true),
      escalationWindowHours: r.num('ESCALATION_WINDOW_HOURS', 24, { min: 1, max: 8760, int: true }),
      dryRun: r.bool('DRY_RUN', true),
      confidenceThreshold: r.num('CONFIDENCE_THRESHOLD', 0.6, { min: 0, max: 1 }),
      dedupeTtlMs: r.num('DEDUPE_TTL_MS', 10_000, { min: 0, int: true }),
      rulesPath: r.str('MODERATION_CONFIG_PATH', { default: './config/moderation.json' }),
    },
    privacy: {
      requireMonitoringNotice: r.bool('REQUIRE_MONITORING_NOTICE', true),
      transcriptLogging: r.bool('TRANSCRIPT_LOGGING', false),
    },
    evidence: {
      enabled: evidenceEnabled,
      directory: r.str('VIOLATION_AUDIO_DIRECTORY', { default: './violation-audio' }),
      retentionDays: r.num('VIOLATION_AUDIO_RETENTION_DAYS', 7, { min: 0, max: 3650, int: true }),
      prebufferMs: r.num('VIOLATION_AUDIO_PREBUFFER_MS', 1000, { min: 0, max: 30_000, int: true }),
      postbufferMs: r.num('VIOLATION_AUDIO_POSTBUFFER_MS', 500, { min: 0, max: 30_000, int: true }),
      delayAction: r.bool('VIOLATION_AUDIO_DELAY_ACTION', false),
      allowDiscordUpload: r.bool('EVIDENCE_ALLOW_DISCORD_UPLOAD', false),
      biometricRiskAcknowledged: biometricAck,
    },
    storage: {
      driver: r.enum('STORAGE_DRIVER', STORAGE_DRIVERS, 'auto'),
      databasePath: r.str('DATABASE_PATH', { default: './data/birdeye-cop.db' }),
      moderationLogRetentionDays: r.num('MODERATION_LOG_RETENTION_DAYS', 90, {
        min: 0,
        max: 3650,
        int: true,
      }),
      retentionSweepIntervalMs: r.num('RETENTION_SWEEP_INTERVAL_MS', 3_600_000, {
        min: 60_000,
        int: true,
      }),
    },
    ops: {
      logLevel: r.enum('LOG_LEVEL', LOG_LEVELS, 'info'),
      logPretty: r.bool('LOG_PRETTY', false),
      strictPermissions: r.bool('STRICT_PERMISSIONS', false),
    },
  };

  r.finish();
  return config;
}

/** Human-readable summary for startup logs. Contains no secrets. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    sttProvider: config.stt.provider,
    sttModel: config.stt.model,
    sttVerifyModel: config.stt.verifyModel,
    weakVerify: config.stt.weakVerify,
    sttConcurrency: config.stt.maxConcurrency,
    actionCeiling: config.moderation.actionCeiling,
    dryRun: config.moderation.dryRun,
    moderationEnabled: config.moderation.enabled,
    confidenceThreshold: config.moderation.confidenceThreshold,
    transcriptLogging: config.privacy.transcriptLogging,
    monitoringNotice: config.privacy.requireMonitoringNotice,
    evidenceEnabled: config.evidence.enabled,
    storageDriver: config.storage.driver,
    monitoredChannels: config.discord.monitoredVoiceChannelIds.length,
  };
}
