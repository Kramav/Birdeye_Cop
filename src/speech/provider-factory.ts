import { ConfigError } from '../utils/errors.js';
import type { SttConfig, SttProviderName } from '../config/types.js';
import { DeepgramProvider } from './providers/deepgram.js';
import { MockSttProvider } from './providers/mock.js';
import { OpenAiCompatibleProvider } from './providers/openai-compatible.js';
import type { ISttProvider } from './types.js';

export interface ProviderFactoryOptions {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  language?: string;
  fetchImpl?: typeof fetch;
}

export function createProvider(
  name: SttProviderName,
  opts: ProviderFactoryOptions,
): ISttProvider {
  switch (name) {
    case 'mock':
      return new MockSttProvider({ defaultText: '', defaultConfidence: 0.95 });

    case 'openai':
      if (!opts.baseUrl) {
        throw new ConfigError('STT_BASE_URL is required for the openai provider');
      }
      return new OpenAiCompatibleProvider({
        baseUrl: opts.baseUrl,
        defaultModel: opts.model,
        ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });

    case 'deepgram':
      if (!opts.apiKey) {
        throw new ConfigError('STT_API_KEY is required for the deepgram provider');
      }
      return new DeepgramProvider({
        apiKey: opts.apiKey,
        defaultModel: opts.model,
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });

    default: {
      const exhaustive: never = name;
      throw new ConfigError(`Unknown speech-to-text provider: ${String(exhaustive)}`);
    }
  }
}

/** Build both the primary and the second-opinion providers from config. */
export function createProviderPair(
  config: SttConfig,
  fetchImpl?: typeof fetch,
): { primary: ISttProvider; verify: ISttProvider } {
  const shared = {
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.language ? { language: config.language } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  };

  const primary = createProvider(config.provider, { ...shared, model: config.model });

  // Reuse the same instance when nothing differs, so the mock provider's call
  // counting stays coherent and no extra HTTP agent is created.
  const verify =
    config.verifyProvider === config.provider && config.verifyModel === config.model
      ? primary
      : createProvider(config.verifyProvider, { ...shared, model: config.verifyModel });

  return { primary, verify };
}
