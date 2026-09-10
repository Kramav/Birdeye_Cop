import { SttError } from '../../utils/errors.js';
import { encodeWav } from '../../voice/pcm.js';
import type { ISttProvider, TranscriptionRequest, TranscriptionResult } from '../types.js';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey?: string;
  defaultModel: string;
  language?: string;
  fetchImpl?: typeof fetch;
}

interface VerboseSegment {
  avg_logprob?: number;
  no_speech_prob?: number;
}

interface TranscriptionResponse {
  text?: string;
  segments?: VerboseSegment[];
  logprobs?: { logprob?: number }[];
}

/**
 * Any endpoint speaking OpenAI's `/audio/transcriptions` API.
 *
 * That deliberately covers three very different deployments with one code
 * path: OpenAI itself, drop-in hosts like Groq, and a local `whisper.cpp`
 * `whisper-server` — for which "run speech-to-text entirely on my own
 * hardware, with no audio leaving the network" is just a different
 * `STT_BASE_URL`.
 */
export class OpenAiCompatibleProvider implements ISttProvider {
  readonly name = 'openai';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const model = req.model ?? this.opts.defaultModel;
    const started = Date.now();

    // The endpoint needs a container, not raw samples. Building the WAV in
    // memory avoids an ffmpeg dependency entirely.
    const wav = encodeWav(req.pcm, req.sampleRate);

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
    form.append('model', model);
    form.append('temperature', '0');

    const language = req.language ?? this.opts.language;
    if (language) form.append('language', language);

    // Whisper-family models expose per-segment log-probabilities through
    // verbose_json; the gpt-4o transcription models do not support that
    // format and return token logprobs instead.
    const isWhisperFamily = /whisper|distil|faster|base|small|medium|large|tiny/i.test(model);
    if (isWhisperFamily) {
      form.append('response_format', 'verbose_json');
    } else {
      form.append('response_format', 'json');
      form.append('include[]', 'logprobs');
    }

    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

    const url = `${this.opts.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: form,
        signal: req.signal,
      });
    } catch (err) {
      // Network-level failures are worth retrying; an abort is not.
      const aborted = req.signal.aborted;
      throw new SttError(
        `Speech-to-text request to ${url} failed: ${(err as Error).message}`,
        !aborted,
        undefined,
        { cause: err },
      );
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new SttError(
        `Speech-to-text returned ${response.status}: ${truncate(body, 300)}`,
        // 4xx means our request is wrong; retrying reproduces it. 429 is the
        // exception — it is a timing problem, not a correctness one.
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    let payload: TranscriptionResponse;
    try {
      payload = (await response.json()) as TranscriptionResponse;
    } catch (err) {
      throw new SttError('Speech-to-text returned a malformed JSON body', true, response.status, {
        cause: err,
      });
    }

    return {
      text: (payload.text ?? '').trim(),
      confidence: deriveConfidence(payload),
      provider: this.name,
      model,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Turn log-probabilities into a 0..1 confidence.
 *
 * `avg_logprob` is a mean log-probability per token, so `exp()` maps it back
 * to a probability. It is then scaled down by the model's own estimate that
 * the audio was not speech at all, which is the signal that most often
 * distinguishes a genuine utterance from a confidently-hallucinated one.
 */
export function deriveConfidence(payload: TranscriptionResponse): number | null {
  if (Array.isArray(payload.segments) && payload.segments.length > 0) {
    let logprobSum = 0;
    let logprobCount = 0;
    let worstSpeechProb = 1;

    for (const segment of payload.segments) {
      if (typeof segment.avg_logprob === 'number' && Number.isFinite(segment.avg_logprob)) {
        logprobSum += segment.avg_logprob;
        logprobCount++;
      }
      if (typeof segment.no_speech_prob === 'number') {
        worstSpeechProb = Math.min(worstSpeechProb, 1 - segment.no_speech_prob);
      }
    }

    if (logprobCount === 0) return null;
    const tokenConfidence = Math.exp(logprobSum / logprobCount);
    return clamp01(tokenConfidence * worstSpeechProb);
  }

  if (Array.isArray(payload.logprobs) && payload.logprobs.length > 0) {
    const values = payload.logprobs
      .map((entry) => entry.logprob)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (values.length === 0) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return clamp01(Math.exp(mean));
  }

  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
