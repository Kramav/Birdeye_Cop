import { Client, GatewayIntentBits, Options } from 'discord.js';

/**
 * Discord client with the minimum intents this bot needs.
 *
 * `Guilds` supplies the channel and role cache the permission checks depend
 * on; `GuildVoiceStates` is what makes voice-state updates visible. Notably
 * absent is `MessageContent`, which is privileged and entirely unnecessary —
 * every interaction with this bot is a slash command.
 */
export function createClient(): Client {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
    // Message caching is pure overhead for a bot that never reads messages.
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      ReactionManager: 0,
    }),
  });
}
