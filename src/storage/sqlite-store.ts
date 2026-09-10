import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type DatabaseType from 'better-sqlite3';
import { LATEST_VERSION, MIGRATIONS } from './migrations.js';
import type {
  EventQuery,
  EvidenceQuery,
  EvidenceRecord,
  GuildSettings,
  ModerationEvent,
  ModerationStore,
} from './types.js';
import type { ModerationActionType, RuleType, Severity } from '../moderation/types.js';

type Db = DatabaseType.Database;

interface EventRow {
  id: string;
  created_at: number;
  guild_id: string;
  channel_id: string;
  user_id: string;
  segment_id: string;
  rule_id: string;
  rule_type: string;
  severity: string;
  action: string;
  action_taken: number;
  dry_run: number;
  confidence: number | null;
  verified: number;
  provider: string;
  model: string;
  transcript_hash: string;
  transcript: string | null;
  matched_text: string | null;
  evidence_id: string | null;
  failure_reason: string | null;
}

interface EvidenceRow {
  id: string;
  created_at: number;
  expires_at: number;
  guild_id: string;
  channel_id: string;
  user_id: string;
  segment_id: string;
  rule_id: string;
  action: string;
  filename: string;
  file_path: string;
  duration_ms: number;
  byte_size: number;
  transcript: string | null;
}

interface SettingsRow {
  guild_id: string;
  moderation_enabled: number | null;
  action_ceiling: string | null;
  dry_run: number | null;
  monitored_channel_ids: string | null;
  updated_at: number;
}

function toEvent(row: EventRow): ModerationEvent {
  return {
    id: row.id,
    createdAt: row.created_at,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    segmentId: row.segment_id,
    ruleId: row.rule_id,
    ruleType: row.rule_type as RuleType,
    severity: row.severity as Severity,
    action: row.action as ModerationActionType,
    actionTaken: row.action_taken === 1,
    dryRun: row.dry_run === 1,
    confidence: row.confidence,
    verified: row.verified === 1,
    provider: row.provider,
    model: row.model,
    transcriptHash: row.transcript_hash,
    ...(row.transcript !== null ? { transcript: row.transcript } : {}),
    ...(row.matched_text !== null ? { matchedText: row.matched_text } : {}),
    ...(row.evidence_id !== null ? { evidenceId: row.evidence_id } : {}),
    ...(row.failure_reason !== null ? { failureReason: row.failure_reason } : {}),
  };
}

function toEvidence(row: EvidenceRow): EvidenceRecord {
  return {
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    guildId: row.guild_id,
    channelId: row.channel_id,
    userId: row.user_id,
    segmentId: row.segment_id,
    ruleId: row.rule_id,
    action: row.action as ModerationActionType,
    filename: row.filename,
    filePath: row.file_path,
    durationMs: row.duration_ms,
    byteSize: row.byte_size,
    ...(row.transcript !== null ? { transcript: row.transcript } : {}),
  };
}

/**
 * SQLite persistence via better-sqlite3.
 *
 * better-sqlite3 is synchronous, which suits this workload: writes are small,
 * infrequent, and happen on a moderation event rather than in the audio path,
 * so there is nothing to gain from async I/O and a great deal to gain from
 * real transactions when a moderation event and its evidence row must land
 * together or not at all.
 */
export class SqliteModerationStore implements ModerationStore {
  private db: Db | undefined;

  constructor(private readonly databasePath: string) {}

  async init(): Promise<void> {
    const path = resolve(this.databasePath);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });

    // Imported lazily: better-sqlite3 is an optional dependency so that a
    // failed native build degrades to the JSONL store instead of preventing
    // the bot from starting at all.
    const mod = await import('better-sqlite3');
    const Database = mod.default ?? mod;

    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');

    this.migrate(db);
    this.db = db;
  }

  private migrate(db: Db): void {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;
    const current = row?.version ?? 0;

    if (current >= LATEST_VERSION) return;

    const apply = db.transaction(() => {
      for (const migration of MIGRATIONS) {
        if (migration.version > current) db.exec(migration.sql);
      }
      if (row) {
        db.prepare('UPDATE schema_version SET version = ?').run(LATEST_VERSION);
      } else {
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(LATEST_VERSION);
      }
    });
    apply();
  }

  private get handle(): Db {
    if (!this.db) throw new Error('SqliteModerationStore.init() has not been called');
    return this.db;
  }

  close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
    return Promise.resolve();
  }

  recordEvent(event: ModerationEvent): Promise<void> {
    this.handle
      .prepare(
        `INSERT OR REPLACE INTO moderation_events (
           id, created_at, guild_id, channel_id, user_id, segment_id, rule_id, rule_type,
           severity, action, action_taken, dry_run, confidence, verified, provider, model,
           transcript_hash, transcript, matched_text, evidence_id, failure_reason
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        event.id,
        event.createdAt,
        event.guildId,
        event.channelId,
        event.userId,
        event.segmentId,
        event.ruleId,
        event.ruleType,
        event.severity,
        event.action,
        event.actionTaken ? 1 : 0,
        event.dryRun ? 1 : 0,
        event.confidence,
        event.verified ? 1 : 0,
        event.provider,
        event.model,
        event.transcriptHash,
        event.transcript ?? null,
        event.matchedText ?? null,
        event.evidenceId ?? null,
        event.failureReason ?? null,
      );
    return Promise.resolve();
  }

  listEvents(query: EventQuery): Promise<ModerationEvent[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.guildId) {
      clauses.push('guild_id = ?');
      params.push(query.guildId);
    }
    if (query.userId) {
      clauses.push('user_id = ?');
      params.push(query.userId);
    }
    if (query.since !== undefined) {
      clauses.push('created_at >= ?');
      params.push(query.since);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(query.limit ?? 50);

    const rows = this.handle
      .prepare(`SELECT * FROM moderation_events ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as EventRow[];

    return Promise.resolve(rows.map(toEvent));
  }

  countViolations(guildId: string, userId: string, since: number): Promise<number> {
    const row = this.handle
      .prepare(
        `SELECT COUNT(*) AS n FROM moderation_events
         WHERE guild_id = ? AND user_id = ? AND created_at >= ?`,
      )
      .get(guildId, userId, since) as { n: number };
    return Promise.resolve(row.n);
  }

  pruneEvents(olderThan: number): Promise<number> {
    const info = this.handle
      .prepare('DELETE FROM moderation_events WHERE created_at < ?')
      .run(olderThan);
    return Promise.resolve(info.changes);
  }

  recordEvidence(record: EvidenceRecord): Promise<void> {
    this.handle
      .prepare(
        `INSERT OR REPLACE INTO evidence (
           id, created_at, expires_at, guild_id, channel_id, user_id, segment_id,
           rule_id, action, filename, file_path, duration_ms, byte_size, transcript
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.id,
        record.createdAt,
        record.expiresAt,
        record.guildId,
        record.channelId,
        record.userId,
        record.segmentId,
        record.ruleId,
        record.action,
        record.filename,
        record.filePath,
        record.durationMs,
        record.byteSize,
        record.transcript ?? null,
      );
    return Promise.resolve();
  }

  getEvidence(id: string): Promise<EvidenceRecord | undefined> {
    const row = this.handle.prepare('SELECT * FROM evidence WHERE id = ?').get(id) as
      | EvidenceRow
      | undefined;
    return Promise.resolve(row ? toEvidence(row) : undefined);
  }

  listEvidence(query: EvidenceQuery): Promise<EvidenceRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (query.guildId) {
      clauses.push('guild_id = ?');
      params.push(query.guildId);
    }
    if (query.userId) {
      clauses.push('user_id = ?');
      params.push(query.userId);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(query.limit ?? 25);

    const rows = this.handle
      .prepare(`SELECT * FROM evidence ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as EvidenceRow[];

    return Promise.resolve(rows.map(toEvidence));
  }

  deleteEvidence(id: string): Promise<EvidenceRecord | undefined> {
    const db = this.handle;
    const remove = db.transaction((evidenceId: string) => {
      const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(evidenceId) as
        | EvidenceRow
        | undefined;
      if (!row) return undefined;
      db.prepare('DELETE FROM evidence WHERE id = ?').run(evidenceId);
      return row;
    });

    const row = remove(id);
    return Promise.resolve(row ? toEvidence(row) : undefined);
  }

  findExpiredEvidence(now: number): Promise<EvidenceRecord[]> {
    const rows = this.handle
      .prepare('SELECT * FROM evidence WHERE expires_at <= ?')
      .all(now) as EvidenceRow[];
    return Promise.resolve(rows.map(toEvidence));
  }

  getGuildSettings(guildId: string): Promise<GuildSettings | undefined> {
    const row = this.handle.prepare('SELECT * FROM guild_settings WHERE guild_id = ?').get(
      guildId,
    ) as SettingsRow | undefined;

    if (!row) return Promise.resolve(undefined);

    return Promise.resolve({
      guildId: row.guild_id,
      ...(row.moderation_enabled !== null
        ? { moderationEnabled: row.moderation_enabled === 1 }
        : {}),
      ...(row.action_ceiling !== null
        ? { actionCeiling: row.action_ceiling as ModerationActionType }
        : {}),
      ...(row.dry_run !== null ? { dryRun: row.dry_run === 1 } : {}),
      ...(row.monitored_channel_ids !== null
        ? { monitoredChannelIds: JSON.parse(row.monitored_channel_ids) as string[] }
        : {}),
      updatedAt: row.updated_at,
    });
  }

  async setGuildSettings(
    guildId: string,
    patch: Partial<Omit<GuildSettings, 'guildId' | 'updatedAt'>>,
  ): Promise<GuildSettings> {
    const existing = (await this.getGuildSettings(guildId)) ?? { guildId, updatedAt: 0 };
    const next: GuildSettings = { ...existing, ...patch, guildId, updatedAt: Date.now() };

    this.handle
      .prepare(
        `INSERT OR REPLACE INTO guild_settings
           (guild_id, moderation_enabled, action_ceiling, dry_run, monitored_channel_ids, updated_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .run(
        next.guildId,
        next.moderationEnabled === undefined ? null : next.moderationEnabled ? 1 : 0,
        next.actionCeiling ?? null,
        next.dryRun === undefined ? null : next.dryRun ? 1 : 0,
        next.monitoredChannelIds ? JSON.stringify(next.monitoredChannelIds) : null,
        next.updatedAt,
      );

    return next;
  }
}
