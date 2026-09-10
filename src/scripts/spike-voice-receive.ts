/**
 * `npm run spike:voice -- <voiceChannelId>`
 *
 * Proves the one thing that cannot be verified offline: that decoded audio
 * actually arrives, per speaker, with correct user attribution.
 *
 * This matters more than it sounds. Discord does not document voice receive,
 * and the mandatory DAVE end-to-end encryption rollout broke it outright in
 * @discordjs/voice 0.19.0/0.19.1 (discordjs/discord.js#11419) — bots saw a
 * healthy connection, speaking events, and zero audio. That failure mode is
 * indistinguishable from a quiet channel unless you measure bytes, which is
 * exactly what this does.
 *
 * Run it with two people talking, ideally at the same time.
 */
import { ChannelType } from 'discord.js';
import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from '@discordjs/voice';
import { Readable } from 'node:stream';
import prism from 'prism-media';
import process from 'node:process';
import { createClient } from '../bot/client.js';
import { loadEnv } from '../config/env.js';
import { DISCORD_CHANNELS, DISCORD_FRAME_SIZE, DISCORD_SAMPLE_RATE, bufferToInt16, rms, stereoToMono } from '../voice/pcm.js';
import { toError } from '../utils/errors.js';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[90m';
const RESET = '\x1b[0m';

const DURATION_MS = Number(process.env.SPIKE_DURATION_MS ?? 45_000);

interface SpeakerStats {
  bytes: number;
  frames: number;
  peakRms: number;
  firstAudioAt?: number;
  speakingEvents: number;
}

const stats = new Map<string, SpeakerStats>();
const names = new Map<string, string>();

function statsFor(userId: string): SpeakerStats {
  let entry = stats.get(userId);
  if (!entry) {
    entry = { bytes: 0, frames: 0, peakRms: 0, speakingEvents: 0 };
    stats.set(userId, entry);
  }
  return entry;
}

async function main(): Promise<void> {
  const config = loadEnv();
  const channelId = process.argv[2] ?? config.discord.monitoredVoiceChannelIds[0];

  if (!channelId) {
    process.stderr.write(
      '\nUsage: npm run spike:voice -- <voiceChannelId>\n' +
        '(or set MONITORED_VOICE_CHANNEL_IDS in .env)\n\n',
    );
    process.exit(2);
  }

  process.stdout.write(`\n${BOLD}Voice receive spike${RESET}\n`);
  process.stdout.write(`${DIM}Listening for ${DURATION_MS / 1000}s. Have two people talk.${RESET}\n\n`);

  const client = createClient();
  await client.login(config.discord.token);
  await new Promise<void>((resolve) => client.once('clientReady', () => resolve()));

  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildVoice) {
    process.stderr.write(`Channel ${channelId} is not a voice channel.\n`);
    await client.destroy();
    process.exit(2);
  }

  process.stdout.write(`Joining ${BOLD}#${channel.name}${RESET}…\n`);

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false, // mandatory: a deafened bot receives nothing
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    process.stderr.write(`${RED}Failed to reach Ready state: ${toError(err).message}${RESET}\n`);
    connection.destroy();
    await client.destroy();
    process.exit(1);
  }

  process.stdout.write(`${GREEN}Connected.${RESET} Waiting for speech…\n\n`);

  // The historical workaround for the receive path not opening until the bot
  // transmits. Toggle with VOICE_SILENCE_KEEPALIVE to find out whether it is
  // still needed on the current Discord backend.
  if (config.voice.silenceKeepalive) {
    const { createAudioPlayer, createAudioResource, StreamType, NoSubscriberBehavior } = await import(
      '@discordjs/voice'
    );
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    connection.subscribe(player);
    player.play(
      createAudioResource(Readable.from([Buffer.from([0xf8, 0xff, 0xfe])]), {
        inputType: StreamType.Opus,
      }),
    );
    process.stdout.write(`${DIM}Silence keepalive: on${RESET}\n`);
  } else {
    process.stdout.write(`${DIM}Silence keepalive: off${RESET}\n`);
  }

  const receiver = connection.receiver;
  const subscribed = new Set<string>();

  receiver.speaking.on('start', (userId: string) => {
    statsFor(userId).speakingEvents++;

    if (!names.has(userId)) {
      const member = channel.guild.members.cache.get(userId);
      names.set(userId, member?.user.username ?? userId);
    }

    if (subscribed.has(userId)) return;
    subscribed.add(userId);

    const opusStream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: config.voice.vadSilenceMs },
    });
    const decoder = new prism.opus.Decoder({
      rate: DISCORD_SAMPLE_RATE,
      channels: DISCORD_CHANNELS,
      frameSize: DISCORD_FRAME_SIZE,
    });

    decoder.on('data', (chunk: Buffer) => {
      const entry = statsFor(userId);
      entry.bytes += chunk.length;
      entry.frames++;
      entry.firstAudioAt ??= Date.now();

      const level = rms(stereoToMono(bufferToInt16(chunk)));
      if (level > entry.peakRms) entry.peakRms = level;
    });

    decoder.on('end', () => subscribed.delete(userId));
    decoder.on('error', (err) => {
      process.stdout.write(`${RED}decoder error for ${userId}: ${err.message}${RESET}\n`);
      subscribed.delete(userId);
    });
    opusStream.on('error', (err) => {
      process.stdout.write(`${RED}stream error for ${userId}: ${err.message}${RESET}\n`);
      subscribed.delete(userId);
    });

    opusStream.pipe(decoder);
  });

  const ticker = setInterval(() => {
    if (stats.size === 0) return;
    const summary = [...stats.entries()]
      .map(([id, s]) => `${names.get(id) ?? id}: ${(s.bytes / 1024).toFixed(0)} KiB`)
      .join('   ');
    process.stdout.write(`\r${DIM}${summary}${RESET}          `);
  }, 1000);

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
  clearInterval(ticker);

  connection.destroy();
  await client.destroy();

  printVerdict(config.voice.silenceKeepalive);
}

function printVerdict(keepalive: boolean): void {
  process.stdout.write(`\n\n${BOLD}Results${RESET}\n`);

  if (stats.size === 0) {
    process.stdout.write(
      `${RED}No speaking events at all.${RESET}\n` +
        `Nobody spoke, the bot lacks View Channel/Connect, or it was server-deafened.\n\n`,
    );
    process.exit(1);
  }

  let withAudio = 0;
  for (const [userId, s] of stats) {
    const name = names.get(userId) ?? userId;
    const ok = s.bytes > 0;
    if (ok) withAudio++;

    process.stdout.write(
      `  ${ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`} ${BOLD}${name}${RESET} ${DIM}(${userId})${RESET}\n` +
        `      speaking events: ${s.speakingEvents}   frames: ${s.frames}   ` +
        `bytes: ${s.bytes}   peak RMS: ${s.peakRms.toFixed(3)}\n`,
    );
  }

  process.stdout.write('\n');

  if (withAudio === 0) {
    process.stdout.write(
      `${RED}${BOLD}FAIL — speaking events arrived but no audio was decoded.${RESET}\n\n` +
        `This is the DAVE / end-to-end-encryption failure mode. Check:\n` +
        `  • @discordjs/voice is pinned to exactly 0.19.2 (earlier 0.19.x is broken)\n` +
        `  • @snazzah/davey loaded — run \`npm run doctor\`\n` +
        `  • the bot joined with selfDeaf: false\n` +
        (keepalive ? '' : `  • try again with VOICE_SILENCE_KEEPALIVE=true\n`) +
        `\nSee: https://github.com/discordjs/discord.js/issues/11419\n\n`,
    );
    process.exit(1);
  }

  if (withAudio < stats.size) {
    process.stdout.write(
      `${YELLOW}PARTIAL — some speakers produced no audio.${RESET} ` +
        `They may have been muted, or subscribed too late.\n\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `${GREEN}${BOLD}PASS — decoded audio received from all ${withAudio} speaker(s), ` +
      `each attributed to a distinct user ID.${RESET}\n\n` +
      `${DIM}Voice receive works on this deployment. ` +
      (stats.size < 2
        ? 'Re-run with two people talking simultaneously to confirm per-speaker separation.'
        : 'Per-speaker separation confirmed.') +
      `${RESET}\n\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`\nSpike failed: ${toError(err).stack ?? toError(err).message}\n\n`);
  process.exit(1);
});
