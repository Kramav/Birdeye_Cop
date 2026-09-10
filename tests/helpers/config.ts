import type {
  AppConfig,
  EvidenceConfig,
  ModerationConfig,
  SttConfig,
  VoiceConfig,
} from '../../src/config/types.js';

export function testVoiceConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    vadSilenceMs: 400,
    segmentCoalesceMs: 600,
    minSpeechMs: 300,
    maxSegmentMs: 10_000,
    vadEnergyThreshold: 0.02,
    silenceKeepalive: true,
    livenessTimeoutMs: 30_000,
    ...overrides,
  };
}

export function testSttConfig(overrides: Partial<SttConfig> = {}): SttConfig {
  return {
    provider: 'mock',
    model: 'mock-primary',
    verifyProvider: 'mock',
    verifyModel: 'mock-verify',
    weakVerify: false,
    maxConcurrency: 2,
    timeoutMs: 5000,
    queueMax: 16,
    breakerThreshold: 2,
    breakerResetMs: 1000,
    ...overrides,
  };
}

export function testModerationConfig(overrides: Partial<ModerationConfig> = {}): ModerationConfig {
  return {
    enabled: true,
    actionCeiling: 'disconnect',
    allowUnattendedBan: false,
    escalationEnabled: false,
    escalationWindowHours: 24,
    dryRun: false,
    confidenceThreshold: 0.6,
    dedupeTtlMs: 10_000,
    rulesPath: './config/moderation.json',
    ...overrides,
  };
}

export function testEvidenceConfig(overrides: Partial<EvidenceConfig> = {}): EvidenceConfig {
  return {
    enabled: false,
    directory: './violation-audio',
    retentionDays: 7,
    prebufferMs: 1000,
    postbufferMs: 500,
    delayAction: false,
    allowDiscordUpload: false,
    biometricRiskAcknowledged: false,
    ...overrides,
  };
}

export function testAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    discord: {
      token: 'test-token',
      clientId: '000000000000000001',
      guildIds: [],
      monitoredVoiceChannelIds: ['channel-1'],
      moderationLogChannelId: '000000000000000002',
      autoJoin: true,
      autoLeaveWhenEmpty: true,
    },
    voice: testVoiceConfig(),
    stt: testSttConfig(),
    moderation: testModerationConfig(),
    privacy: { requireMonitoringNotice: true, transcriptLogging: false },
    evidence: testEvidenceConfig(),
    storage: {
      driver: 'memory',
      databasePath: './data/test.db',
      moderationLogRetentionDays: 90,
      retentionSweepIntervalMs: 3_600_000,
    },
    ops: { logLevel: 'error', logPretty: false, strictPermissions: false },
    ...overrides,
  };
}
