import { describe, expect, it } from 'vitest';
import {
  Deduplicator,
  contentDedupeKey,
  segmentDedupeKey,
} from '../../src/moderation/dedupe.js';

function makeDedupe(ttlMs = 1000) {
  let now = 0;
  const dedupe = new Deduplicator({ ttlMs, clock: () => now });
  return { dedupe, advance: (ms: number) => (now += ms) };
}

describe('Deduplicator', () => {
  it('grants a key exactly once inside the window', () => {
    const { dedupe } = makeDedupe();
    expect(dedupe.claim('k')).toBe(true);
    expect(dedupe.claim('k')).toBe(false);
    expect(dedupe.claim('k')).toBe(false);
  });

  it('grants again once the window has elapsed', () => {
    const { dedupe, advance } = makeDedupe(1000);
    expect(dedupe.claim('k')).toBe(true);

    advance(999);
    expect(dedupe.claim('k')).toBe(false);

    advance(2);
    expect(dedupe.claim('k')).toBe(true);
  });

  it('keeps distinct keys independent', () => {
    const { dedupe } = makeDedupe();
    expect(dedupe.claim('a')).toBe(true);
    expect(dedupe.claim('b')).toBe(true);
  });

  it('exposes membership without claiming', () => {
    const { dedupe } = makeDedupe();
    expect(dedupe.has('k')).toBe(false);
    dedupe.claim('k');
    expect(dedupe.has('k')).toBe(true);
  });

  it('expires stale entries rather than growing without bound', () => {
    const { dedupe, advance } = makeDedupe(100);
    for (let i = 0; i < 50; i++) dedupe.claim(`k${i}`);
    expect(dedupe.size).toBe(50);

    advance(200);
    dedupe.claim('trigger');
    expect(dedupe.size).toBe(1);
  });

  it('enforces a hard entry cap', () => {
    let now = 0;
    const dedupe = new Deduplicator({ ttlMs: 1_000_000, maxEntries: 10, clock: () => now++ });
    for (let i = 0; i < 100; i++) dedupe.claim(`k${i}`);
    expect(dedupe.size).toBeLessThanOrEqual(10);
  });

  it('treats a zero TTL as no deduplication', () => {
    const { dedupe } = makeDedupe(0);
    expect(dedupe.claim('k')).toBe(true);
    expect(dedupe.claim('k')).toBe(true);
  });
});

describe('key construction', () => {
  it('scopes a segment key to guild, user and segment', () => {
    expect(segmentDedupeKey('g', 'u', 's')).toBe('seg:g:u:s');
    expect(segmentDedupeKey('g', 'u', 's')).not.toBe(segmentDedupeKey('g', 'u2', 's'));
  });

  it('separates two users saying the same thing', () => {
    // Both users must be actionable independently; one person's violation must
    // never suppress another's.
    const a = contentDedupeKey('g', 'user-a', 'r1', 'hash');
    const b = contentDedupeKey('g', 'user-b', 'r1', 'hash');
    expect(a).not.toBe(b);
  });

  it('separates segment keys from content keys', () => {
    expect(segmentDedupeKey('g', 'u', 'x')).not.toBe(contentDedupeKey('g', 'u', 'r', 'x'));
  });
});
