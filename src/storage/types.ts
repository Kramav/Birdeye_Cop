import type { ModerationActionType, RuleType, Severity } from '../moderation/types.js';

export interface ModerationEvent {
  id: string;
  createdAt: number;
  guildId: string;
  channelId: string;
  userId: string;
  segmentId: string;
  ruleId: string;
  ruleType: RuleType;
  severity: Severity;
  action: ModerationActionType;
  /** False in dry-run, when the action failed, or when it was downgraded away. */
  actionTaken: boolean;
  dryRun: boolean;
  confidence: number | null;
  /** True when a second-opinion transcription agreed on the same rule. */
  verified: boolean;
  provider: string;
  model: string;
  /** Always present — a stable, non-reversible identifier for the transcript. */
  transcriptHash: string;
  /** Only stored when TRANSCRIPT_LOGGING is enabled. */
  transcript?: string;
  matchedText?: string;
  evidenceId?: string;
  failureReason?: string;
}

export interface EvidenceRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  guildId: string;
  channelId: string;
  userId: string;
  segmentId: string;
  ruleId: string;
  action: ModerationActionType;
  filename: string;
  filePath: string;
  durationMs: number;
  byteSize: number;
  /** Only stored when TRANSCRIPT_LOGGING is enabled. */
  transcript?: string;
}

export interface GuildSettings {
  guildId: string;
  moderationEnabled?: boolean;
  actionCeiling?: ModerationActionType;
  dryRun?: boolean;
  /** Channels opted in via `/moderation join`. */
  monitoredChannelIds?: string[];
  updatedAt: number;
}

export interface EventQuery {
  guildId?: string;
  userId?: string;
  since?: number;
  limit?: number;
}

export interface EvidenceQuery {
  guildId?: string;
  userId?: string;
  limit?: number;
}

/**
 * Persistence boundary.
 *
 * SQLite is the default implementation, but nothing above this interface
 * knows that — the JSONL and in-memory stores satisfy the same contract, so a
 * failed native build degrades the deployment rather than breaking it.
 */
export interface ModerationStore {
  init(): Promise<void>;
  close(): Promise<void>;

  recordEvent(event: ModerationEvent): Promise<void>;
  listEvents(query: EventQuery): Promise<ModerationEvent[]>;
  /** Distinct prior violations, used to drive the escalation ladder. */
  countViolations(guildId: string, userId: string, since: number): Promise<number>;
  pruneEvents(olderThan: number): Promise<number>;

  recordEvidence(record: EvidenceRecord): Promise<void>;
  getEvidence(id: string): Promise<EvidenceRecord | undefined>;
  listEvidence(query: EvidenceQuery): Promise<EvidenceRecord[]>;
  deleteEvidence(id: string): Promise<EvidenceRecord | undefined>;
  findExpiredEvidence(now: number): Promise<EvidenceRecord[]>;

  getGuildSettings(guildId: string): Promise<GuildSettings | undefined>;
  setGuildSettings(
    guildId: string,
    patch: Partial<Omit<GuildSettings, 'guildId' | 'updatedAt'>>,
  ): Promise<GuildSettings>;
}
