import { describe, expect, it } from 'vitest';
import {
  DISCORD_SAMPLE_RATE,
  STT_SAMPLE_RATE,
  bufferToInt16,
  concatInt16,
  decodeWav,
  encodeWav,
  msToSamples,
  resample48kTo16k,
  rms,
  samplesToMs,
  stereoToMono,
} from '../../src/voice/pcm.js';
import { peakAmplitude, tonePcm } from '../helpers/audio.js';

describe('bufferToInt16', () => {
  it('decodes little-endian samples', () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(1000, 2);
    buf.writeInt16LE(-1000, 4);

    expect(Array.from(bufferToInt16(buf))).toEqual([0, 1000, -1000]);
  });

  it('copies rather than aliasing the source buffer', () => {
    // Node stream chunks are frequently views onto a shared pool. If this
    // returned a view, a later write to the pool would silently corrupt audio
    // we are still holding — including audio queued for evidence.
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(500, 0);
    buf.writeInt16LE(600, 2);

    const pcm = bufferToInt16(buf);
    buf.writeInt16LE(-32000, 0);

    expect(pcm[0]).toBe(500);
  });

  it('handles an unaligned byteOffset', () => {
    const backing = Buffer.alloc(7);
    backing.writeInt16LE(1234, 1);
    backing.writeInt16LE(-4321, 3);
    const unaligned = backing.subarray(1, 5);

    expect(Array.from(bufferToInt16(unaligned))).toEqual([1234, -4321]);
  });
});

describe('stereoToMono', () => {
  it('averages the two channels', () => {
    const interleaved = Int16Array.from([100, 300, -200, -400]);
    expect(Array.from(stereoToMono(interleaved))).toEqual([200, -300]);
  });

  it('halves the sample count', () => {
    const stereo = bufferToInt16(tonePcm(100));
    expect(stereoToMono(stereo).length).toBe(stereo.length / 2);
  });
});

describe('resample48kTo16k', () => {
  it('produces exactly one third of the samples', () => {
    const mono = stereoToMono(bufferToInt16(tonePcm(300)));
    const out = resample48kTo16k(mono);

    expect(out.length).toBe(Math.floor(mono.length / 3));
    expect(samplesToMs(out.length, STT_SAMPLE_RATE)).toBeCloseTo(300, 0);
  });

  it('preserves signal amplitude for speech-band content', () => {
    // 300 Hz is well below the 8 kHz Nyquist limit of the output rate, so
    // decimation must not meaningfully attenuate it.
    const mono = stereoToMono(bufferToInt16(tonePcm(200, { frequency: 300, amplitude: 0.5 })));
    const out = resample48kTo16k(mono);

    expect(peakAmplitude(out)).toBeGreaterThan(0.4);
  });
});

describe('rms', () => {
  it('is zero for silence', () => {
    expect(rms(new Int16Array(1000))).toBe(0);
  });

  it('is amplitude/sqrt(2) for a sine wave', () => {
    const mono = stereoToMono(bufferToInt16(tonePcm(100, { amplitude: 0.5 })));
    expect(rms(mono)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('respects the requested range', () => {
    const pcm = new Int16Array(200);
    pcm.fill(16384, 100, 200);

    expect(rms(pcm, 0, 100)).toBe(0);
    expect(rms(pcm, 100, 200)).toBeCloseTo(0.5, 3);
  });
});

describe('encodeWav / decodeWav', () => {
  it('round-trips PCM and sample rate', () => {
    const pcm = Int16Array.from([0, 1000, -1000, 32767, -32768]);
    const { pcm: out, sampleRate } = decodeWav(encodeWav(pcm, STT_SAMPLE_RATE));

    expect(sampleRate).toBe(STT_SAMPLE_RATE);
    expect(Array.from(out)).toEqual(Array.from(pcm));
  });

  it('writes a valid RIFF/WAVE header', () => {
    const wav = encodeWav(new Int16Array(160), STT_SAMPLE_RATE);

    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  });
});

describe('concatInt16', () => {
  it('joins chunks in order', () => {
    const out = concatInt16([
      Int16Array.from([1, 2]),
      Int16Array.from([3]),
      Int16Array.from([4, 5]),
    ]);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns an empty array for no chunks', () => {
    expect(concatInt16([]).length).toBe(0);
  });
});

describe('time conversion', () => {
  it('round-trips ms and samples', () => {
    expect(msToSamples(1000, DISCORD_SAMPLE_RATE)).toBe(48_000);
    expect(samplesToMs(48_000, DISCORD_SAMPLE_RATE)).toBe(1000);
    expect(msToSamples(20, DISCORD_SAMPLE_RATE)).toBe(960);
  });
});
