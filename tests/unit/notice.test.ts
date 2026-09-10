import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import type { VoiceBasedChannel } from 'discord.js';
import { postMonitoringNotice, resetNoticeCooldowns } from '../../src/bot/notice.js';
import { createNullLogger } from '../../src/observability/logger.js';
import { testAppConfig, testEvidenceConfig } from '../helpers/config.js';

interface FakeChannel {
  channel: VoiceBasedChannel;
  send: ReturnType<typeof vi.fn>;
}

function fakeChannel(opts: { canSend?: boolean; id?: string } = {}): FakeChannel {
  const canSend = opts.canSend ?? true;
  const send = vi.fn().mockResolvedValue(undefined);

  const channel = {
    id: opts.id ?? 'channel-1',
    send,
    guild: { id: 'guild-1', members: { me: { id: 'bot' } } },
    permissionsFor: () => ({
      has: (flag: bigint) => (flag === PermissionFlagsBits.SendMessages ? canSend : true),
    }),
  } as unknown as VoiceBasedChannel;

  return { channel, send };
}

beforeEach(() => {
  resetNoticeCooldowns();
});

describe('monitoring notice', () => {
  it('posts before listening', async () => {
    const { channel, send } = fakeChannel();
    const ok = await postMonitoringNotice(channel, testAppConfig(), createNullLogger());

    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses to proceed when it cannot post', async () => {
    // The bot must not listen silently in a channel it cannot announce itself
    // in — that is the whole consent mechanism.
    const { channel, send } = fakeChannel({ canSend: false });
    const ok = await postMonitoringNotice(channel, testAppConfig(), createNullLogger());

    expect(ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reports failure when sending throws', async () => {
    const { channel, send } = fakeChannel();
    send.mockRejectedValueOnce(new Error('rate limited'));

    const ok = await postMonitoringNotice(channel, testAppConfig(), createNullLogger());
    expect(ok).toBe(false);
  });

  it('is skipped entirely when the notice is disabled', async () => {
    const { channel, send } = fakeChannel();
    const config = testAppConfig({
      privacy: { requireMonitoringNotice: false, transcriptLogging: false },
    });

    expect(await postMonitoringNotice(channel, config, createNullLogger())).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  describe('cooldown', () => {
    it('does not repost to the same channel in quick succession', async () => {
      const { channel, send } = fakeChannel();
      const config = testAppConfig();

      await postMonitoringNotice(channel, config, createNullLogger(), { now: 0 });
      await postMonitoringNotice(channel, config, createNullLogger(), { now: 60_000 });

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('reposts once the cooldown expires', async () => {
      const { channel, send } = fakeChannel();
      const config = testAppConfig();

      await postMonitoringNotice(channel, config, createNullLogger(), { now: 0 });
      await postMonitoringNotice(channel, config, createNullLogger(), { now: 11 * 60_000 });

      expect(send).toHaveBeenCalledTimes(2);
    });

    it('is per-channel', async () => {
      const a = fakeChannel({ id: 'a' });
      const b = fakeChannel({ id: 'b' });
      const config = testAppConfig();

      await postMonitoringNotice(a.channel, config, createNullLogger(), { now: 0 });
      await postMonitoringNotice(b.channel, config, createNullLogger(), { now: 0 });

      expect(a.send).toHaveBeenCalledTimes(1);
      expect(b.send).toHaveBeenCalledTimes(1);
    });

    it('is bypassed when an admin explicitly starts monitoring', async () => {
      const { channel, send } = fakeChannel();
      const config = testAppConfig();

      await postMonitoringNotice(channel, config, createNullLogger(), { now: 0 });
      await postMonitoringNotice(channel, config, createNullLogger(), { now: 1000, force: true });

      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('content', () => {
    it('states that no recordings are kept when evidence is off', async () => {
      const { channel, send } = fakeChannel();
      await postMonitoringNotice(channel, testAppConfig(), createNullLogger());

      const embed = send.mock.calls[0][0].embeds[0];
      expect(embed.data.description).toContain('No recordings are kept');
    });

    it('discloses retention when evidence recording is on', async () => {
      const { channel, send } = fakeChannel();
      const config = testAppConfig({
        evidence: testEvidenceConfig({ enabled: true, retentionDays: 14 }),
      });

      await postMonitoringNotice(channel, config, createNullLogger());

      const embed = send.mock.calls[0][0].embeds[0];
      expect(embed.data.description).toContain('14 day(s)');
      expect(embed.data.description).toContain('that speaker only');
    });

    it('names the transcription provider so egress is disclosed', async () => {
      const { channel, send } = fakeChannel();
      await postMonitoringNotice(channel, testAppConfig(), createNullLogger());

      const embed = send.mock.calls[0][0].embeds[0];
      expect(embed.data.description).toContain('mock');
    });
  });
});
