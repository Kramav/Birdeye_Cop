import { DISCORD_FRAME_SIZE, DISCORD_SAMPLE_RATE, msToSamples, rms } from './pcm.js';
import type { ISpeechDetector, SpeechAnalysis } from './types.js';

export interface EnergyVadOptions {
  /** Absolute floor: RMS below this is silence regardless of adaptation. */
  energyThreshold: number;
  /** Shortest run of speech worth transcribing. */
  minSpeechMs: number;
  /** Silence tolerated inside a single utterance before trimming ends it. */
  hangoverMs?: number;
  sampleRate?: number;
  /** Multiplier applied to the tracked noise floor. */
  noiseFloorMultiplier?: number;
}

/**
 * Energy-based voice-activity detection.
 *
 * Discord already applies client-side silence suppression, so this is not
 * doing the heavy lifting of a full VAD — its jobs are to (a) refuse to spend
 * a speech-to-text call on a cough or a keyboard click, and (b) trim dead air
 * off the ends so the provider sees only speech.
 *
 * The adaptive noise floor matters because a noisy channel (fans, game audio,
 * an open mic) otherwise trips a fixed threshold continuously.
 */
export class EnergyVad implements ISpeechDetector {
  private readonly sampleRate: number;
  private readonly frameSize: number;
  private readonly minSpeechSamples: number;
  private readonly hangoverFrames: number;
  private readonly noiseFloorMultiplier: number;

  /** Slowly-tracked estimate of background level, in normalized RMS. */
  private noiseFloor = 0;

  constructor(private readonly opts: EnergyVadOptions) {
    this.sampleRate = opts.sampleRate ?? DISCORD_SAMPLE_RATE;
    this.frameSize = DISCORD_FRAME_SIZE;
    this.minSpeechSamples = msToSamples(opts.minSpeechMs, this.sampleRate);
    this.hangoverFrames = Math.max(
      1,
      Math.round(msToSamples(opts.hangoverMs ?? 200, this.sampleRate) / this.frameSize),
    );
    this.noiseFloorMultiplier = opts.noiseFloorMultiplier ?? 2.5;
  }

  private get threshold(): number {
    return Math.max(this.opts.energyThreshold, this.noiseFloor * this.noiseFloorMultiplier);
  }

  analyze(pcm: Int16Array): SpeechAnalysis {
    if (pcm.length === 0) {
      return { isSpeech: false, startSample: 0, endSample: 0, peakRms: 0 };
    }

    const frameCount = Math.max(1, Math.ceil(pcm.length / this.frameSize));
    const frameRms = new Float64Array(frameCount);
    let peakRms = 0;
    let quietest = Number.POSITIVE_INFINITY;

    for (let f = 0; f < frameCount; f++) {
      const start = f * this.frameSize;
      const value = rms(pcm, start, Math.min(pcm.length, start + this.frameSize));
      frameRms[f] = value;
      if (value > peakRms) peakRms = value;
      if (value < quietest) quietest = value;
    }

    // Adapt the noise floor toward the quietest frame we saw. Fast to rise is
    // dangerous (it would desensitize during speech), so rising is slow and
    // falling is quick.
    if (Number.isFinite(quietest)) {
      this.noiseFloor =
        quietest < this.noiseFloor
          ? quietest
          : this.noiseFloor * 0.95 + Math.min(quietest, this.opts.energyThreshold) * 0.05;
    }

    const threshold = this.threshold;

    let firstVoiced = -1;
    let lastVoiced = -1;
    for (let f = 0; f < frameCount; f++) {
      if (frameRms[f] >= threshold) {
        if (firstVoiced === -1) firstVoiced = f;
        lastVoiced = f;
      }
    }

    if (firstVoiced === -1) {
      return { isSpeech: false, startSample: 0, endSample: 0, peakRms };
    }

    // Pad by the hangover so we do not clip quiet consonants at the edges.
    const startFrame = Math.max(0, firstVoiced - this.hangoverFrames);
    const endFrame = Math.min(frameCount - 1, lastVoiced + this.hangoverFrames);

    const startSample = startFrame * this.frameSize;
    const endSample = Math.min(pcm.length, (endFrame + 1) * this.frameSize);

    const isSpeech = endSample - startSample >= this.minSpeechSamples;

    return { isSpeech, startSample, endSample, peakRms };
  }

  isTailSilent(pcm: Int16Array, windowMs: number): boolean {
    if (pcm.length === 0) return true;
    const windowSamples = msToSamples(windowMs, this.sampleRate);
    const start = Math.max(0, pcm.length - windowSamples);
    return rms(pcm, start, pcm.length) < this.threshold;
  }

  /** Exposed for diagnostics and tests. */
  get currentThreshold(): number {
    return this.threshold;
  }
}
