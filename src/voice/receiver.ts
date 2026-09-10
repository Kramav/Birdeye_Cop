import { Readable } from 'node:stream';
import {
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { AudioPlayer, VoiceConnection, VoiceReceiver } from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import type { AppConfig } from '../config/types.js';
import { LogEvent } from '../observability/events.js';
import type { Logger } from '../observability/logger.js';
import { toError } from '../utils/errors.js';
import { KeyedMutex } from '../utils/mutex.js';
import { userKey } from '../utils/id.js';
import type { RingHandle } from '../moderation/pipeline.js';
import { DISCORD_CHANNELS, DISCORD_FRAME_SIZE, DISCORD_SAMPLE_RATE } from './pcm.js';
import { TimestampedPcmRing } from './ring-buffer.js';
import { EnergyVad } from './speech-detector.js';
import { UserAudioStream } from './user-stream.js';
import type { AudioSegment, IAudioReceiver, SegmentHandler } from './types.js';

/**
 * A single Opus frame of silence.
 *
 * Transmitting one on join is a long-standing workaround for the receive path
 * not being established until the bot has sent something. It predates DAVE and
 * may now be redundant, so it sits behind VOICE_SILENCE_KEEPALIVE.
 */
const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

/**
 * How long a speaker's rolling buffer outlives their stream.
 *
 * A segment can still be in the transcription queue when its speaker leaves,
 * and evidence for it is captured after that. Retiring the buffer immediately
 * would lose exactly the audio a violation needs.
 */
const RING_RETIREMENT_MS = 15_000;

interface ActiveSubscription {
  opusStream: NodeJS.ReadableStream;
  decoder: prism.opus.Decoder;
}

export interface GuildVoiceSessionOptions {
  guildId: string;
  channelId: string;
  connection: VoiceConnection;
  config: AppConfig;
  logger: Logger;
  onSegment: SegmentHandler;
  /** Late-bound: the bot's own ID is not known until the gateway is ready. */
  getSelfUserId: () => string | undefined;
  clock?: () => number;
}

/**
 * Owns every per-user audio stream for one voice channel.
 *
 * All per-speaker state lives in maps keyed by `guildId:userId` and is created
 * here and nowhere else. Nothing is pooled or reused between speakers, which
 * is what makes it structurally impossible for one person's audio to end up
 * attributed to another.
 */
export class GuildVoiceSession {
  private readonly streams = new Map<string, UserAudioStream>();
  private readonly rings = new Map<
    string,
    { ring: TimestampedPcmRing; ownerUserId: string; retireTimer?: NodeJS.Timeout }
  >();
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly mutex = new KeyedMutex();
  private readonly receiver: VoiceReceiver;
  private readonly clock: () => number;

  private player: AudioPlayer | undefined;
  private livenessTimer: NodeJS.Timeout | undefined;
  private lastPcmAt = 0;
  private lastSpeakingAt = 0;
  private livenessWarned = false;
  private closed = false;

  constructor(private readonly opts: GuildVoiceSessionOptions) {
    this.clock = opts.clock ?? Date.now;
    this.receiver = opts.connection.receiver;
    this.lastPcmAt = this.clock();

    this.attachConnectionHandlers();
    this.attachSpeakingHandlers();
    if (opts.config.voice.silenceKeepalive) this.startSilenceKeepalive();
    this.startLivenessWatchdog();
  }

  get guildId(): string {
    return this.opts.guildId;
  }

  get channelId(): string {
    return this.opts.channelId;
  }

  get activeSpeakers(): number {
    return this.streams.size;
  }

  // -- Discord wiring ----------------------------------------------------

  private attachConnectionHandlers(): void {
    const { connection, logger } = this.opts;

    connection.on('error', (err) => {
      logger.error(LogEvent.DISCORD_VOICE_ERROR, {
        guildId: this.guildId,
        channelId: this.channelId,
        err: toError(err),
      });
    });

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnect();
    });
  }

  private async handleDisconnect(): Promise<void> {
    const { connection, logger } = this.opts;
    try {
      // A disconnect is usually a channel move or a brief websocket blip, both
      // of which resolve themselves. Only a genuine failure to re-establish
      // warrants tearing the session down.
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
      logger.info(LogEvent.VOICE_RECONNECTED, {
        guildId: this.guildId,
        channelId: this.channelId,
      });
    } catch {
      logger.warn(LogEvent.DISCORD_VOICE_ERROR, {
        guildId: this.guildId,
        channelId: this.channelId,
        message: 'Voice connection could not be re-established; destroying session',
      });
      await this.destroy();
    }
  }

  /**
   * Transmit a single silence frame so the receive path is established.
   */
  private startSilenceKeepalive(): void {
    try {
      this.player = createAudioPlayer({
        behaviors: { noSubscriber: NoSubscriberBehavior.Play },
      });
      this.opts.connection.subscribe(this.player);
      this.player.play(
        createAudioResource(Readable.from([SILENCE_FRAME]), { inputType: StreamType.Opus }),
      );
      this.player.on('error', (err) => {
        this.opts.logger.debug(LogEvent.DISCORD_VOICE_ERROR, {
          guildId: this.guildId,
          message: 'Silence keepalive player error',
          err: toError(err),
        });
      });
    } catch (err) {
      this.opts.logger.warn(LogEvent.DISCORD_VOICE_ERROR, {
        guildId: this.guildId,
        message: 'Could not start silence keepalive',
        err: toError(err),
      });
    }
  }

  private attachSpeakingHandlers(): void {
    this.receiver.speaking.on('start', (userId: string) => {
      this.lastSpeakingAt = this.clock();
      void this.mutex
        .runExclusive(userKey(this.guildId, userId), () => this.subscribeUser(userId))
        .catch((err: unknown) => {
          this.opts.logger.error(LogEvent.DISCORD_VOICE_ERROR, {
            guildId: this.guildId,
            userId,
            message: 'Failed to subscribe to speaker',
            err: toError(err),
          });
        });
    });
  }

  private subscribeUser(userId: string): void {
    if (this.closed) return;
    if (userId === this.opts.getSelfUserId()) return;
    // A subscription is already running; its audio continues to flow into the
    // same UserAudioStream.
    if (this.subscriptions.has(userId)) return;

    const stream = this.ensureStream(userId);

    const opusStream = this.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: this.opts.config.voice.vadSilenceMs,
      },
    });

    const decoder = new prism.opus.Decoder({
      rate: DISCORD_SAMPLE_RATE,
      channels: DISCORD_CHANNELS,
      frameSize: DISCORD_FRAME_SIZE,
    });

    this.subscriptions.set(userId, { opusStream, decoder });

    this.opts.logger.debug(LogEvent.VOICE_USER_STARTED, {
      guildId: this.guildId,
      channelId: this.channelId,
      userId,
    });

    decoder.on('data', (chunk: Buffer) => {
      this.lastPcmAt = this.clock();
      this.livenessWarned = false;
      stream.appendPcm(chunk);
    });

    const onFailure = (err: unknown) => {
      this.opts.logger.warn(LogEvent.DISCORD_VOICE_ERROR, {
        guildId: this.guildId,
        userId,
        message: 'Audio stream error',
        err: toError(err),
      });
      this.teardownSubscription(userId);
    };

    opusStream.on('error', onFailure);
    decoder.on('error', onFailure);

    // Wait for the decoder rather than the raw stream, so every decoded frame
    // has reached the segmenter before the segment boundary is evaluated.
    decoder.on('end', () => {
      this.subscriptions.delete(userId);
      this.opts.logger.debug(LogEvent.VOICE_USER_STOPPED, {
        guildId: this.guildId,
        channelId: this.channelId,
        userId,
      });
      if (!this.closed) stream.markSubscriptionEnd();
    });

    opusStream.pipe(decoder);
  }

  private ensureStream(userId: string): UserAudioStream {
    const key = userKey(this.guildId, userId);
    const existing = this.streams.get(key);
    if (existing && !existing.isDestroyed) return existing;

    const ring = this.ensureRing(key, userId);

    const stream = new UserAudioStream({
      guildId: this.guildId,
      channelId: this.channelId,
      userId,
      detector: new EnergyVad({
        energyThreshold: this.opts.config.voice.vadEnergyThreshold,
        minSpeechMs: this.opts.config.voice.minSpeechMs,
      }),
      config: this.opts.config.voice,
      onSegment: this.opts.onSegment,
      logger: this.opts.logger,
      ...(ring ? { ring } : {}),
      ...(this.opts.clock ? { clock: this.opts.clock } : {}),
    });

    this.streams.set(key, stream);
    return stream;
  }

  /** Rolling buffers exist only when violation-audio logging is enabled. */
  private ensureRing(key: string, userId: string): TimestampedPcmRing | undefined {
    const { evidence, voice } = this.opts.config;
    if (!evidence.enabled) return undefined;

    const existing = this.rings.get(key);
    if (existing) {
      if (existing.retireTimer) {
        clearTimeout(existing.retireTimer);
        delete existing.retireTimer;
      }
      return existing.ring;
    }

    const retentionMs = evidence.prebufferMs + voice.maxSegmentMs + evidence.postbufferMs + 2000;
    const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, retentionMs);
    this.rings.set(key, { ring, ownerUserId: userId });
    return ring;
  }

  /**
   * Look up the rolling buffer that belongs to a segment's speaker.
   *
   * The owner is re-checked here even though the key is derived from the
   * segment: the recorder asserts it again before writing, and two cheap
   * checks on different data are worth more than one.
   *
   * The channel check matters for a specific case: if the bot has moved
   * channels since the segment was captured, this session's buffers belong to
   * a different conversation. The speaker might well be the same person, so
   * the identity assertion alone would pass — and the clip would be audio from
   * somewhere they were not accused of saying anything.
   */
  resolveRing(segment: AudioSegment): RingHandle | undefined {
    if (segment.channelId !== this.channelId) return undefined;

    const entry = this.rings.get(userKey(segment.guildId, segment.userId));
    if (!entry) return undefined;
    if (entry.ownerUserId !== segment.userId) return undefined;
    return { ring: entry.ring, ownerUserId: entry.ownerUserId };
  }

  // -- lifecycle ---------------------------------------------------------

  private teardownSubscription(userId: string): void {
    const active = this.subscriptions.get(userId);
    if (!active) return;
    this.subscriptions.delete(userId);

    try {
      active.opusStream.unpipe?.(active.decoder);
    } catch {
      /* already unpiped */
    }
    active.decoder.destroy();
    (active.opusStream as Readable).destroy?.();
  }

  /**
   * Stop capturing a user. Buffered speech is flushed by default so that
   * someone who leaves mid-sentence is still moderated for what they said.
   */
  async releaseUser(userId: string, opts: { flush?: boolean } = {}): Promise<void> {
    const key = userKey(this.guildId, userId);
    await this.mutex.runExclusive(key, () => {
      this.teardownSubscription(userId);

      const stream = this.streams.get(key);
      if (stream) {
        stream.destroy({ flush: opts.flush ?? true });
        this.streams.delete(key);
      }

      this.retireRing(key);
    });
  }

  private retireRing(key: string): void {
    const entry = this.rings.get(key);
    if (!entry || entry.retireTimer) return;

    entry.retireTimer = setTimeout(() => {
      const current = this.rings.get(key);
      current?.ring.clear();
      this.rings.delete(key);
    }, RING_RETIREMENT_MS);
    entry.retireTimer.unref?.();
  }

  private startLivenessWatchdog(): void {
    const timeout = this.opts.config.voice.livenessTimeoutMs;
    this.livenessTimer = setInterval(() => {
      if (this.closed) return;
      const now = this.clock();

      // The failure this catches is silent: the connection reports healthy and
      // speaking events arrive, but no audio is ever decoded. Without it, a
      // broken receive path is indistinguishable from a quiet channel.
      const speakingRecently = now - this.lastSpeakingAt < timeout;
      const noAudio = now - this.lastPcmAt >= timeout;

      if (speakingRecently && noAudio && !this.livenessWarned) {
        this.livenessWarned = true;
        this.opts.logger.error(LogEvent.VOICE_LIVENESS_WARNING, {
          guildId: this.guildId,
          channelId: this.channelId,
          msSinceAudio: now - this.lastPcmAt,
          message:
            'Speaking events are arriving but no audio has been decoded. ' +
            'Voice receive may be broken — check @discordjs/voice and DAVE support.',
        });
      }
    }, Math.max(5000, Math.floor(timeout / 2)));

    this.livenessTimer.unref?.();
  }

  async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.livenessTimer) clearInterval(this.livenessTimer);

    for (const userId of [...this.subscriptions.keys()]) {
      this.teardownSubscription(userId);
    }

    for (const [key, stream] of this.streams) {
      stream.destroy({ flush: false });
      this.streams.delete(key);
    }

    for (const [key, entry] of this.rings) {
      if (entry.retireTimer) clearTimeout(entry.retireTimer);
      entry.ring.clear();
      this.rings.delete(key);
    }

    this.player?.stop(true);
    this.receiver.speaking.removeAllListeners();

    try {
      this.opts.connection.destroy();
    } catch {
      // Already destroyed; nothing to do.
    }

    this.opts.logger.info(LogEvent.VOICE_LEFT, {
      guildId: this.guildId,
      channelId: this.channelId,
    });

    await Promise.resolve();
  }
}

export interface VoiceManagerOptions {
  config: AppConfig;
  logger: Logger;
  onSegment: SegmentHandler;
  getSelfUserId: () => string | undefined;
  clock?: () => number;
}

/** Tracks one voice session per guild — Discord permits no more than that. */
export class VoiceManager implements IAudioReceiver {
  private readonly sessions = new Map<string, GuildVoiceSession>();
  private readonly joinMutex = new KeyedMutex();

  constructor(private readonly opts: VoiceManagerOptions) {}

  start(): Promise<void> {
    return Promise.resolve();
  }

  async join(channel: VoiceBasedChannel): Promise<GuildVoiceSession> {
    return this.joinMutex.runExclusive(channel.guild.id, async () => {
      const existing = this.sessions.get(channel.guild.id);
      if (existing) {
        if (existing.channelId === channel.id) return existing;
        await existing.destroy();
        this.sessions.delete(channel.guild.id);
      }

      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        // A self-deafened bot receives no audio at all.
        selfDeaf: false,
        // Required to transmit the silence keepalive frame.
        selfMute: false,
      });

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch (err) {
        connection.destroy();
        throw new Error(
          `Timed out connecting to voice channel ${channel.id}: ${(err as Error).message}`,
        );
      }

      const session = new GuildVoiceSession({
        guildId: channel.guild.id,
        channelId: channel.id,
        connection,
        config: this.opts.config,
        logger: this.opts.logger,
        onSegment: this.opts.onSegment,
        getSelfUserId: this.opts.getSelfUserId,
        ...(this.opts.clock ? { clock: this.opts.clock } : {}),
      });

      this.sessions.set(channel.guild.id, session);

      this.opts.logger.info(LogEvent.VOICE_JOINED, {
        guildId: channel.guild.id,
        channelId: channel.id,
      });

      return session;
    });
  }

  async leave(guildId: string): Promise<void> {
    await this.joinMutex.runExclusive(guildId, async () => {
      const session = this.sessions.get(guildId);
      if (!session) return;
      this.sessions.delete(guildId);
      await session.destroy();
    });
  }

  getSession(guildId: string): GuildVoiceSession | undefined {
    return this.sessions.get(guildId);
  }

  /** Resolve a segment's rolling buffer from the session that produced it. */
  resolveRing(segment: AudioSegment): RingHandle | undefined {
    return this.sessions.get(segment.guildId)?.resolveRing(segment);
  }

  async stop(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.destroy()));
  }
}
