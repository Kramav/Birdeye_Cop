import { endianness } from 'node:os';

/** Discord delivers decoded Opus as 48 kHz, 16-bit, stereo PCM. */
export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;
/** 20 ms frame at 48 kHz — the Opus frame size Discord uses. */
export const DISCORD_FRAME_SIZE = 960;

/** Rate we hand to speech-to-text. Speech models are trained at 16 kHz. */
export const STT_SAMPLE_RATE = 16_000;

const HOST_IS_LE = endianness() === 'LE';

/**
 * Convert a little-endian s16 Buffer into an Int16Array.
 *
 * This ALWAYS copies. Node stream chunks are frequently views onto a shared
 * internal buffer pool, so returning a zero-copy view would let a later,
 * unrelated write silently corrupt audio we are still holding — and for
 * evidence recording that could mean writing another user's audio into a
 * violation clip. The copy is cheap relative to Opus decoding and removes the
 * hazard entirely.
 */
export function bufferToInt16(buf: Buffer): Int16Array {
  const sampleCount = buf.length >> 1;
  const out = new Int16Array(sampleCount);

  if (HOST_IS_LE && buf.byteOffset % 2 === 0) {
    // `set` performs the copy; the temporary view is never retained.
    out.set(new Int16Array(buf.buffer, buf.byteOffset, sampleCount));
    return out;
  }

  for (let i = 0; i < sampleCount; i++) {
    out[i] = buf.readInt16LE(i * 2);
  }
  return out;
}

/** Interleaved stereo (L,R,L,R…) to mono by averaging the channels. */
export function stereoToMono(interleaved: Int16Array): Int16Array {
  const frames = interleaved.length >> 1;
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = ((interleaved[i * 2] + interleaved[i * 2 + 1]) / 2) | 0;
  }
  return out;
}

/**
 * Downsample 48 kHz mono to 16 kHz by averaging each group of three samples.
 *
 * The boxcar average acts as a crude anti-aliasing low-pass. It is not a
 * polyphase FIR, but for 300–3400 Hz speech content the difference is
 * inaudible to a speech model, and it costs no dependency and no CPU worth
 * measuring on an old processor.
 */
export function resample48kTo16k(mono48k: Int16Array): Int16Array {
  const outLength = Math.floor(mono48k.length / 3);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const j = i * 3;
    out[i] = ((mono48k[j] + mono48k[j + 1] + mono48k[j + 2]) / 3) | 0;
  }
  return out;
}

/** Root-mean-square amplitude over a sample range, normalized to 0..1. */
export function rms(pcm: Int16Array, start = 0, end = pcm.length): number {
  const from = Math.max(0, start);
  const to = Math.min(pcm.length, end);
  if (to <= from) return 0;

  let sum = 0;
  for (let i = from; i < to; i++) {
    const s = pcm[i] / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / (to - from));
}

export function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms * sampleRate) / 1000);
}

export function samplesToMs(samples: number, sampleRate: number): number {
  return (samples * 1000) / sampleRate;
}

export function concatInt16(chunks: readonly Int16Array[]): Int16Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Encode mono 16-bit PCM as a RIFF/WAVE file.
 *
 * Written by hand so that neither ffmpeg nor any encoding library is a
 * dependency — the OpenAI-compatible STT endpoint needs a container, and this
 * is the whole of what it needs.
 */
export function encodeWav(pcm: Int16Array, sampleRate: number): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length * 2;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  const body = Buffer.alloc(dataSize);
  for (let i = 0; i < pcm.length; i++) {
    body.writeInt16LE(pcm[i], i * 2);
  }

  return Buffer.concat([header, body]);
}

/** Read a WAV produced by `encodeWav` back into PCM. Used by tests. */
export function decodeWav(buf: Buffer): { pcm: Int16Array; sampleRate: number } {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a RIFF/WAVE buffer');
  }
  const sampleRate = buf.readUInt32LE(24);
  const dataSize = buf.readUInt32LE(40);
  const pcm = new Int16Array(dataSize >> 1);
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = buf.readInt16LE(44 + i * 2);
  }
  return { pcm, sampleRate };
}

/** Silence of a given duration, used to pad evidence post-roll. */
export function silence(ms: number, sampleRate: number): Int16Array {
  return new Int16Array(msToSamples(ms, sampleRate));
}
