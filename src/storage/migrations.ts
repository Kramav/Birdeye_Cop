/**
 * Schema migrations, applied in order. Each entry runs exactly once and the
 * applied version is recorded, so upgrading an existing deployment never
 * requires manual SQL.
 */
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS moderation_events (
        id              TEXT PRIMARY KEY,
        created_at      INTEGER NOT NULL,
        guild_id        TEXT    NOT NULL,
        channel_id      TEXT    NOT NULL,
        user_id         TEXT    NOT NULL,
        segment_id      TEXT    NOT NULL,
        rule_id         TEXT    NOT NULL,
        rule_type       TEXT    NOT NULL,
        severity        TEXT    NOT NULL,
        action          TEXT    NOT NULL,
        action_taken    INTEGER NOT NULL,
        dry_run         INTEGER NOT NULL,
        confidence      REAL,
        verified        INTEGER NOT NULL,
        provider        TEXT    NOT NULL,
        model           TEXT    NOT NULL,
        transcript_hash TEXT    NOT NULL,
        transcript      TEXT,
        matched_text    TEXT,
        evidence_id     TEXT,
        failure_reason  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_events_guild_user_time
        ON moderation_events (guild_id, user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_created
        ON moderation_events (created_at);

      CREATE TABLE IF NOT EXISTS evidence (
        id          TEXT PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL,
        guild_id    TEXT    NOT NULL,
        channel_id  TEXT    NOT NULL,
        user_id     TEXT    NOT NULL,
        segment_id  TEXT    NOT NULL,
        rule_id     TEXT    NOT NULL,
        action      TEXT    NOT NULL,
        filename    TEXT    NOT NULL,
        file_path   TEXT    NOT NULL,
        duration_ms INTEGER NOT NULL,
        byte_size   INTEGER NOT NULL,
        transcript  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_evidence_expires ON evidence (expires_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_guild_time ON evidence (guild_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_evidence_user ON evidence (user_id);

      CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id              TEXT PRIMARY KEY,
        moderation_enabled    INTEGER,
        action_ceiling        TEXT,
        dry_run               INTEGER,
        monitored_channel_ids TEXT,
        updated_at            INTEGER NOT NULL
      );
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
