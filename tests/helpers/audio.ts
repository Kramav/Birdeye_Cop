import { DISCORD_SAMPLE_RATE } from '../../src/voice/pcm.js';

export interface TonePcmOptions {
  /** Peak amplitude, 0..1. */
  amplitude?: number;
  frequency?: number;
  sampleRate?: number;
  channels?: number;
}

/**
 * Interleaved 16-bit little-endian PCM, matching what `prism.opus.Decoder`
 * emits for Discord voice (48 kHz stereo by default).
 */
export function tonePcm(ms: number, opts: TonePcmOptions = {}): Buffer {
  const {
    amplitude = 0.5,
    frequency = 440,
    sampleRate = DISCORD_SAMPLE_RATE,
    channels = 2,
  } = opts;

  const frames = Math.round((ms * sampleRate) / 1000);
  const buf = Buffer.alloc(frames * channels * 2);

  for (let i = 0; i < frames; i++) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * 32767,
    );
    for (let c = 0; c < channels; c++) {
      buf.writeInt16LE(sample, (i * channels + c) * 2);
    }
  }
  return buf;
}

export function silencePcm(ms: number, opts: Omit<TonePcmOptions, 'amplitude'> = {}): Buffer {
  return tonePcm(ms, { ...opts, amplitude: 0 });
}

/** Peak absolute amplitude of a PCM array, normalized to 0..1. */
export function peakAmplitude(pcm: Int16Array): number {
  let peak = 0;
  for (const s of pcm) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
  }
  return peak / 32768;
}
