import { beforeEach, describe, expect, it } from 'vitest';
import { resolveAction } from '../../src/moderation/escalation.js';
import { MemoryModerationStore } from '../../src/storage/memory-store.js';
import { capAction } from '../../src/moderation/types.js';
import type { ModerationEvent } from '../../src/storage/types.js';

let store: MemoryModerationStore;

const NOW = 1_000_000_000;

beforeEach(async () => {
  store = new MemoryModerationStore();
  await store.init();
});

async function seedViolations(count: number, userId = 'u1'): Promise<void> {
  for (let i = 0; i < count; i++) {
    const event: ModerationEvent = {
      id: `e${i}`,
      createdAt: NOW - 1000,
      guildId: 'g1',
      channelId: 'c1',
      userId,
      segmentId: `s${i}`,
      ruleId: 'r1',
      ruleType: 'word',
      severity: 'medium',
      action: 'warn',
      actionTaken: true,
      dryRun: false,
      confidence: 0.9,
      verified: true,
      provider: 'mock',
      model: 'mock-1',
      transcriptHash: 'h',
    };
    await store.recordEvent(event);
  }
}

const base = {
  guildId: 'g1',
  userId: 'u1',
  severity: 'medium' as const,
  ceiling: 'ban' as const,
  escalationEnabled: true,
  escalationWindowHours: 24,
  allowUnattendedBan: true,
  clock: () => NOW,
};

describe('escalation ladder', () => {
  it('warns on a first offence rather than removing someone', async () => {
    const decision = await resolveAction({ ...base, store });
    expect(decision.action).toBe('warn');
    expect(decision.priorViolations).toBe(0);
  });

  it.each([
    [1, 'disconnect'],
    [2, 'kick'],
    [3, 'ban'],
    [10, 'ban'],
  ])('escalates to %s after %i prior violations', async (count, expected) => {
    await seedViolations(count);
    const decision = await resolveAction({ ...base, store });
    expect(decision.action).toBe(expected);
  });

  it('starts high-severity rules one rung higher', async () => {
    const decision = await resolveAction({ ...base, store, severity: 'high' });
    expect(decision.action).toBe('disconnect');
  });

  it('ignores violations outside the window', async () => {
    const store2 = new MemoryModerationStore();
    await store2.init();
    await store2.recordEvent({
      id: 'old',
      createdAt: NOW - 48 * 60 * 60 * 1000,
      guildId: 'g1',
      channelId: 'c1',
      userId: 'u1',
      segmentId: 's',
      ruleId: 'r1',
      ruleType: 'word',
      severity: 'medium',
      action: 'warn',
      actionTaken: true,
      dryRun: false,
      confidence: 0.9,
      verified: true,
      provider: 'mock',
      model: 'm',
      transcriptHash: 'h',
    });

    const decision = await resolveAction({ ...base, store: store2 });
    expect(decision.priorViolations).toBe(0);
    expect(decision.action).toBe('warn');
  });

  it('counts only the user in question', async () => {
    await seedViolations(3, 'someone-else');
    const decision = await resolveAction({ ...base, store });
    expect(decision.action).toBe('warn');
  });
});

describe('rule action as a floor', () => {
  it('uses the rule action when it is more severe than the ladder', async () => {
    const decision = await resolveAction({ ...base, store, ruleAction: 'kick' });
    expect(decision.action).toBe('kick');
  });

  it('keeps the ladder result when it is more severe than the rule action', async () => {
    await seedViolations(3);
    const decision = await resolveAction({ ...base, store, ruleAction: 'warn' });
    expect(decision.action).toBe('ban');
  });

  it('uses the rule action directly when escalation is disabled', async () => {
    const decision = await resolveAction({
      ...base,
      store,
      escalationEnabled: false,
      ruleAction: 'kick',
    });
    expect(decision.action).toBe('kick');
    expect(decision.priorViolations).toBe(0);
  });

  it('falls back to the ceiling when escalation is off and the rule names no action', async () => {
    const decision = await resolveAction({
      ...base,
      store,
      escalationEnabled: false,
      ceiling: 'disconnect',
    });
    expect(decision.action).toBe('disconnect');
  });
});

describe('ceiling', () => {
  it('never exceeds the configured maximum', async () => {
    await seedViolations(5);
    const decision = await resolveAction({ ...base, store, ceiling: 'disconnect' });
    expect(decision.action).toBe('disconnect');
  });

  it('caps a more severe rule action', async () => {
    const decision = await resolveAction({
      ...base,
      store,
      ruleAction: 'ban',
      ceiling: 'warn',
    });
    expect(decision.action).toBe('warn');
  });

  it('capAction picks the less severe of the two', () => {
    expect(capAction('ban', 'kick')).toBe('kick');
    expect(capAction('warn', 'ban')).toBe('warn');
    expect(capAction('kick', 'kick')).toBe('kick');
  });
});

describe('ban gating', () => {
  it('downgrades an unattended ban to a kick and flags it', async () => {
    await seedViolations(5);
    const decision = await resolveAction({ ...base, store, allowUnattendedBan: false });

    expect(decision.action).toBe('kick');
    expect(decision.banWithheld).toBe(true);
  });

  it('permits a ban when explicitly enabled', async () => {
    await seedViolations(5);
    const decision = await resolveAction({ ...base, store, allowUnattendedBan: true });

    expect(decision.action).toBe('ban');
    expect(decision.banWithheld).toBe(false);
  });

  it('does not flag withholding when no ban was reached', async () => {
    const decision = await resolveAction({ ...base, store, allowUnattendedBan: false });
    expect(decision.banWithheld).toBe(false);
  });
});
