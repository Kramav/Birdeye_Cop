import { SttError } from '../../utils/errors.js';
import { sleep } from '../../utils/async.js';
import type { ISttProvider, TranscriptionRequest, TranscriptionResult } from '../types.js';

export type MockScriptEntry =
  | string
  | { text: string; confidence?: number | null; delayMs?: number }
  | Error;

export interface MockSttOptions {
  /** Consumed in order; the last entry repeats once exhausted. */
  script?: MockScriptEntry[];
  defaultText?: string;
  defaultConfidence?: number | null;
  delayMs?: number;
  name?: string;
}

/**
 * Scripted provider for tests and for running the bot with no credentials.
 *
 * Honours the abort signal so timeout and teardown behaviour can be exercised
 * without a network.
 */
export class MockSttProvider implements ISttProvider {
  readonly name: string;
  private index = 0;
  private readonly script: MockScriptEntry[];

  constructor(private readonly opts: MockSttOptions = {}) {
    this.name = opts.name ?? 'mock';
    this.script = opts.script ?? [];
  }

  /** Number of transcribe() calls received. */
  callCount = 0;
  /** Models requested, in order. Lets tests assert the verify pass differs. */
  readonly modelsRequested: string[] = [];

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    this.callCount++;
    this.modelsRequested.push(req.model ?? 'mock-1');

    const entry =
      this.script.length > 0
        ? this.script[Math.min(this.index++, this.script.length - 1)]
        : undefined;

    const delay = (typeof entry === 'object' && !(entry instanceof Error) ? entry.delayMs : undefined) ?? this.opts.delayMs ?? 0;
    const started = Date.now();

    if (delay > 0) {
      await sleep(delay, req.signal);
    }
    if (req.signal.aborted) {
      throw new SttError('Aborted before completion', true);
    }

    if (entry instanceof Error) throw entry;

    const text = typeof entry === 'string' ? entry : (entry?.text ?? this.opts.defaultText ?? '');
    const confidence =
      typeof entry === 'object' && !(entry instanceof Error) && entry.confidence !== undefined
        ? entry.confidence
        : (this.opts.defaultConfidence ?? 0.95);

    return {
      text,
      confidence,
      provider: this.name,
      model: req.model ?? 'mock-1',
      durationMs: Date.now() - started,
    };
  }

  reset(): void {
    this.index = 0;
    this.callCount = 0;
    this.modelsRequested.length = 0;
  }
}
