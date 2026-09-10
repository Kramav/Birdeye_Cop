import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlModerationStore } from '../../src/storage/jsonl-store.js';
import { MemoryModerationStore } from '../../src/storage/memory-store.js';
import { SqliteModerationStore } from '../../src/storage/sqlite-store.js';
import type { EvidenceRecord, ModerationEvent, ModerationStore } from '../../src/storage/types.js';

const NOW = 1_700_000_000_000;
const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'birdeye-store-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  // Windows keeps SQLite's -wal/-shm sidecars locked until every handle is
  // closed, and a stray temp directory is not worth failing a suite over.
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)),
  );
});

function event(overrides: Partial<ModerationEvent> = {}): ModerationEvent {
  return {
    id: `event-${Math.random().toString(16).slice(2)}`,
    createdAt: NOW,
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    segmentId: 's1',
    ruleId: 'r1',
    ruleType: 'word',
    severity: 'medium',
    action: 'disconnect',
    actionTaken: true,
    dryRun: false,
    confidence: 0.87,
    verified: true,
    provider: 'mock',
    model: 'mock-1',
    transcriptHash: 'abc123',
    ...overrides,
  };
}

function evidence(overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: `evidence-${Math.random().toString(16).slice(2)}`,
    createdAt: NOW,
    expiresAt: NOW + 86_400_000,
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    segmentId: 's1',
    ruleId: 'r1',
    action: 'kick',
    filename: 'x.wav',
    filePath: '/tmp/x.wav',
    durationMs: 2500,
    byteSize: 1234,
    ...overrides,
  };
}

/**
 * The same contract, run against every driver.
 *
 * The point of the abstraction is that a failed native build can fall back to
 * JSONL without anything above the store noticing, which is only true if the
 * implementations genuinely agree.
 */
const drivers: Array<{ name: string; make: () => Promise<ModerationStore> }> = [
  { name: 'memory', make: () => Promise.resolve(new MemoryModerationStore()) },
  {
    name: 'jsonl',
    make: async () => new JsonlModerationStore(join(await tempDir(), 'db.sqlite')),
  },
  {
    name: 'sqlite',
    make: async () => new SqliteModerationStore(join(await tempDir(), 'db.sqlite')),
  },
];

describe.each(drivers)('$name store', ({ make }) => {
  let store: ModerationStore;

  beforeEach(async () => {
    store = await make();
    await store.init();
  });

  afterEach(async () => {
    // Closing matters: an unclosed better-sqlite3 handle holds the database
    // file open, which is exactly the kind of leak this project audits for.
    await store.close();
  });

  describe('moderation events', () => {
    it('round-trips an event', async () => {
      const e = event({ transcript: 'hello', matchedText: 'hello', evidenceId: 'ev-1' });
      await store.recordEvent(e);

      const [stored] = await store.listEvents({ guildId: 'g1' });
      expect(stored).toMatchObject({
        id: e.id,
        userId: 'u1',
        ruleId: 'r1',
        actionTaken: true,
        dryRun: false,
        confidence: 0.87,
        verified: true,
        transcript: 'hello',
        evidenceId: 'ev-1',
      });
    });

    it('omits optional fields that were never set', async () => {
      await store.recordEvent(event());
      const [stored] = await store.listEvents({});
      expect(stored.transcript).toBeUndefined();
      expect(stored.evidenceId).toBeUndefined();
      expect(stored.failureReason).toBeUndefined();
    });

    it('filters by user', async () => {
      await store.recordEvent(event({ userId: 'a' }));
      await store.recordEvent(event({ userId: 'b' }));

      expect(await store.listEvents({ userId: 'a' })).toHaveLength(1);
    });

    it('returns newest first and honours the limit', async () => {
      await store.recordEvent(event({ createdAt: NOW - 1000 }));
      await store.recordEvent(event({ createdAt: NOW }));
      await store.recordEvent(event({ createdAt: NOW - 2000 }));

      const rows = await store.listEvents({ limit: 2 });
      expect(rows).toHaveLength(2);
      expect(rows[0].createdAt).toBe(NOW);
    });

    it('counts violations within a window for one user', async () => {
      await store.recordEvent(event({ userId: 'u1', createdAt: NOW }));
      await store.recordEvent(event({ userId: 'u1', createdAt: NOW - 1000 }));
      await store.recordEvent(event({ userId: 'u1', createdAt: NOW - 999_999 }));
      await store.recordEvent(event({ userId: 'other', createdAt: NOW }));

      expect(await store.countViolations('g1', 'u1', NOW - 5000)).toBe(2);
      expect(await store.countViolations('g1', 'nobody', 0)).toBe(0);
    });

    it('prunes events older than a cutoff', async () => {
      await store.recordEvent(event({ createdAt: NOW - 100_000 }));
      await store.recordEvent(event({ createdAt: NOW }));

      expect(await store.pruneEvents(NOW - 50_000)).toBe(1);
      expect(await store.listEvents({})).toHaveLength(1);
    });
  });

  describe('evidence', () => {
    it('round-trips a record', async () => {
      const record = evidence({ transcript: 'said something' });
      await store.recordEvidence(record);

      const stored = await store.getEvidence(record.id);
      expect(stored).toMatchObject({
        id: record.id,
        userId: 'u1',
        durationMs: 2500,
        byteSize: 1234,
        transcript: 'said something',
      });
    });

    it('returns undefined for an unknown ID', async () => {
      expect(await store.getEvidence('nope')).toBeUndefined();
    });

    it('lists and filters by user', async () => {
      await store.recordEvidence(evidence({ userId: 'a' }));
      await store.recordEvidence(evidence({ userId: 'b' }));

      expect(await store.listEvidence({ guildId: 'g1' })).toHaveLength(2);
      expect(await store.listEvidence({ userId: 'a' })).toHaveLength(1);
    });

    it('deletes and returns the removed record', async () => {
      const record = evidence();
      await store.recordEvidence(record);

      const deleted = await store.deleteEvidence(record.id);
      expect(deleted?.id).toBe(record.id);
      expect(await store.getEvidence(record.id)).toBeUndefined();
      expect(await store.deleteEvidence(record.id)).toBeUndefined();
    });

    it('finds expired records only', async () => {
      await store.recordEvidence(evidence({ expiresAt: NOW - 1 }));
      await store.recordEvidence(evidence({ expiresAt: NOW + 100_000 }));

      const expired = await store.findExpiredEvidence(NOW);
      expect(expired).toHaveLength(1);
    });
  });

  describe('guild settings', () => {
    it('returns undefined before anything is stored', async () => {
      expect(await store.getGuildSettings('g1')).toBeUndefined();
    });

    it('persists and merges partial updates', async () => {
      await store.setGuildSettings('g1', { dryRun: false });
      await store.setGuildSettings('g1', { actionCeiling: 'kick' });

      const stored = await store.getGuildSettings('g1');
      expect(stored?.dryRun).toBe(false);
      expect(stored?.actionCeiling).toBe('kick');
    });

    it('round-trips the monitored channel list', async () => {
      await store.setGuildSettings('g1', { monitoredChannelIds: ['c1', 'c2'] });
      expect((await store.getGuildSettings('g1'))?.monitoredChannelIds).toEqual(['c1', 'c2']);
    });

    it('keeps guilds separate', async () => {
      await store.setGuildSettings('g1', { dryRun: true });
      await store.setGuildSettings('g2', { dryRun: false });

      expect((await store.getGuildSettings('g1'))?.dryRun).toBe(true);
      expect((await store.getGuildSettings('g2'))?.dryRun).toBe(false);
    });
  });
});

describe('persistence across restarts', () => {
  it('sqlite reloads what it wrote', async () => {
    const path = join(await tempDir(), 'persist.db');

    const first = new SqliteModerationStore(path);
    await first.init();
    const e = event();
    await first.recordEvent(e);
    await first.setGuildSettings('g1', { dryRun: false, monitoredChannelIds: ['c9'] });
    await first.close();

    const second = new SqliteModerationStore(path);
    await second.init();

    expect((await second.listEvents({}))[0].id).toBe(e.id);
    expect((await second.getGuildSettings('g1'))?.monitoredChannelIds).toEqual(['c9']);
    await second.close();
  });

  it('jsonl reloads what it wrote', async () => {
    const dir = await tempDir();
    const path = join(dir, 'db.sqlite');

    const first = new JsonlModerationStore(path);
    await first.init();
    const record = evidence();
    await first.recordEvidence(record);
    await first.setGuildSettings('g1', { actionCeiling: 'ban' });
    await first.close();

    const second = new JsonlModerationStore(path);
    await second.init();

    expect((await second.getEvidence(record.id))?.id).toBe(record.id);
    expect((await second.getGuildSettings('g1'))?.actionCeiling).toBe('ban');
    await second.close();
  });

  it('jsonl survives a torn trailing line', async () => {
    const dir = await tempDir();
    const path = join(dir, 'db.sqlite');

    const first = new JsonlModerationStore(path);
    await first.init();
    await first.recordEvent(event());
    await first.close();

    // Simulate an append interrupted mid-write.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, 'moderation-events.jsonl'), '{"id":"broken",');

    const second = new JsonlModerationStore(path);
    await second.init();
    expect(await second.listEvents({})).toHaveLength(1);
    await second.close();
  });
});
