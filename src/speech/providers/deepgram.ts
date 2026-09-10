import { SttError } from '../../utils/errors.js';
import type { ISttProvider, TranscriptionRequest, TranscriptionResult } from '../types.js';

export interface DeepgramOptions {
  apiKey: string;
  defaultModel: string;
  baseUrl?: string;
  language?: string;
  fetchImpl?: typeof fetch;
}

interface DeepgramAlternative {
  transcript?: string;
  confidence?: number;
}

interface DeepgramResponse {
  results?: {
    channels?: { alternatives?: DeepgramAlternative[] }[];
  };
}

/**
 * Deepgram pre-recorded transcription.
 *
 * Two properties make this the best fit for moderation: raw PCM is accepted
 * directly, so there is no container encoding step in the latency path, and it
 * returns a genuine confidence score rather than one derived from
 * log-probabilities — which is what `CONFIDENCE_THRESHOLD` is actually meant
 * to be comparing against.
 */
export class DeepgramProvider implements ISttProvider {
  readonly name = 'deepgram';
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly opts: DeepgramOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.baseUrl = (opts.baseUrl ?? 'https://api.deepgram.com/v1').replace(/\/+$/, '');
  }

  async transcribe(req: TranscriptionRequest): Promise<TranscriptionResult> {
    const model = req.model ?? this.opts.defaultModel;
    const started = Date.now();

    const params = new URLSearchParams({
      model,
      encoding: 'linear16',
      sample_rate: String(req.sampleRate),
      channels: '1',
      punctuate: 'true',
      smart_format: 'true',
    });
    const language = req.language ?? this.opts.language;
    if (language) params.set('language', language);

    const url = `${this.baseUrl}/listen?${params.toString()}`;

    // Copy into a standalone ArrayBuffer: the PCM may be a view onto a larger
    // buffer, and sending the whole backing store would leak unrelated audio.
    const body = new Uint8Array(
      req.pcm.buffer.slice(req.pcm.byteOffset, req.pcm.byteOffset + req.pcm.byteLength),
    );

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.opts.apiKey}`,
          'Content-Type': 'audio/l16',
        },
        body,
        signal: req.signal,
      });
    } catch (err) {
      throw new SttError(
        `Deepgram request failed: ${(err as Error).message}`,
        !req.signal.aborted,
        undefined,
        { cause: err },
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable body>');
      throw new SttError(
        `Deepgram returned ${response.status}: ${text.slice(0, 300)}`,
        response.status >= 500 || response.status === 429,
        response.status,
      );
    }

    let payload: DeepgramResponse;
    try {
      payload = (await response.json()) as DeepgramResponse;
    } catch (err) {
      throw new SttError('Deepgram returned a malformed JSON body', true, response.status, {
        cause: err,
      });
    }

    const alternative = payload.results?.channels?.[0]?.alternatives?.[0];

    return {
      text: (alternative?.transcript ?? '').trim(),
      confidence:
        typeof alternative?.confidence === 'number'
          ? Math.min(1, Math.max(0, alternative.confidence))
          : null,
      provider: this.name,
      model,
      durationMs: Date.now() - started,
    };
  }
}
