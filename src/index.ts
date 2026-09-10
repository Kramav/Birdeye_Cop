import { createClient } from './bot/client.js';
import type { BotContext } from './bot/context.js';
import { registerInteractionHandler } from './bot/events/interaction-create.js';
import { registerVoiceStateHandler } from './bot/events/voice-state-update.js';
import { onReady } from './bot/events/ready.js';
import { ModerationReporter } from './bot/log-channel.js';
import { describeConfig, loadEnv } from './config/env.js';
import { DisabledEvidenceRecorder, EvidenceRecorder } from './evidence/recorder.js';
import { RetentionSweeper } from './evidence/store.js';
import type { IEvidenceRecorder } from './evidence/types.js';
import { DiscordModerationAction } from './moderation/actions.js';
import { ModerationPipeline } from './moderation/pipeline.js';
import { RulesService } from './moderation/rules-service.js';
import { LogEvent } from './observability/events.js';
import { createLogger } from './observability/logger.js';
import type { Logger } from './observability/logger.js';
import { createProviderPair } from './speech/provider-factory.js';
import { CircuitBreaker, FairQueue } from './speech/queue.js';
import { TranscriptionService } from './speech/transcription-service.js';
import { createStore } from './storage/index.js';
import { GuildSettingsService } from './storage/settings-store.js';
import { fireAndForget } from './utils/async.js';
import { ConfigError, toError } from './utils/errors.js';
import { VoiceManager } from './voice/receiver.js';

/**
 * Teardown callbacks, in construction order.
 *
 * Startup can fail after the database or the Discord client is already open —
 * an invalid token is the common case. Calling `process.exit()` with native
 * handles still live aborts the process under libuv instead of exiting
 * cleanly, so even the fatal path unwinds through here.
 */
const disposers: Array<{ name: string; dispose: () => Promise<void> | void }> = [];

function onDispose(name: string, dispose: () => Promise<void> | void): void {
  disposers.push({ name, dispose });
}

async function disposeAll(logger?: Logger): Promise<void> {
  // Reverse order: tear down what was built last, first.
  for (const { name, dispose } of [...disposers].reverse()) {
    try {
      await dispose();
    } catch (err) {
      logger?.error(LogEvent.BOT_SHUTDOWN, { resource: name, err: toError(err) });
    }
  }
  disposers.length = 0;
}

/**
 * Exit by letting the event loop drain, not by calling `process.exit()`.
 *
 * Forcing an exit while a handle is mid-close aborts the process under libuv
 * on Windows, and it truncates pending writes to stderr — which can swallow
 * the very error the operator needs to read. The timer is a backstop for a
 * handle that never closes; because it is unreferenced it fires only if
 * something else is still holding the loop open, and never delays a clean
 * exit.
 */
function exitWhenDrained(code: number): void {
  process.exitCode = code;
  const hardExit = setTimeout(() => process.exit(code), 5000);
  hardExit.unref?.();
}

async function main(): Promise<void> {
  const config = loadEnv();

  const logger = createLogger({
    level: config.ops.logLevel,
    // The single enforcement point for transcript privacy: no call site can
    // log speech content unless this is on.
    transcriptLogging: config.privacy.transcriptLogging,
    pretty: config.ops.logPretty,
  });

  logger.info(LogEvent.BOT_STARTING, describeConfig(config));
  warnAboutRiskySettings(config, logger);

  const { store, driver } = await createStore(config.storage, logger);
  onDispose('store', () => store.close());
  logger.info(LogEvent.CONFIG_LOADED, { storageDriver: driver });

  const settings = new GuildSettingsService(store, config);
  const rules = await RulesService.create(config.moderation.rulesPath, logger);
  logger.info(LogEvent.CONFIG_LOADED, { rules: rules.ruleCount });

  const { primary, verify } = createProviderPair(config.stt);
  const queue = new FairQueue({
    concurrency: config.stt.maxConcurrency,
    maxQueued: config.stt.queueMax,
    logger,
  });
  onDispose('transcription queue', () => queue.destroy());
  const breaker = new CircuitBreaker({
    threshold: config.stt.breakerThreshold,
    resetMs: config.stt.breakerResetMs,
    logger,
  });
  const transcription = new TranscriptionService({
    primary,
    verify,
    config: config.stt,
    queue,
    breaker,
    logger,
  });

  const client = createClient();
  onDispose('discord client', () => client.destroy());
  const reporter = new ModerationReporter(client, config, logger);

  const evidenceRecorder: IEvidenceRecorder = config.evidence.enabled
    ? new EvidenceRecorder({ config: config.evidence, store, logger })
    : new DisabledEvidenceRecorder();

  const sweeper = new RetentionSweeper({
    store,
    evidence: config.evidence,
    storage: config.storage,
    logger,
  });

  // The voice manager and the pipeline each need the other: segments flow one
  // way, rolling-buffer lookups the other. A holder breaks the construction
  // cycle without either taking a hard dependency on the other's lifetime.
  const pipelineRef: { current?: ModerationPipeline } = {};

  const voice = new VoiceManager({
    config,
    logger,
    getSelfUserId: () => client.user?.id,
    onSegment: (segment) => {
      const pipeline = pipelineRef.current;
      if (!pipeline) return;
      // The audio path must never await moderation, and must never be able to
      // surface an unhandled rejection.
      fireAndForget(pipeline.handleSegment(segment), logger, LogEvent.MODERATION_ERROR, {
        segmentId: segment.segmentId,
        userId: segment.userId,
      });
    },
  });

  const pipeline = new ModerationPipeline({
    getMatcher: () => rules.matcher,
    transcription,
    store,
    settings,
    evidenceRecorder,
    action: new DiscordModerationAction(client, logger),
    config,
    logger,
    resolveRing: (segment) => voice.resolveRing(segment),
    onEvent: (event, context) => {
      fireAndForget(reporter.report(event, context), logger, LogEvent.MODERATION_ERROR, {
        eventId: event.id,
      });
    },
  });
  pipelineRef.current = pipeline;

  const ctx: BotContext = {
    client,
    config,
    logger,
    store,
    settings,
    rules,
    voice,
    reporter,
    sweeper,
  };

  registerInteractionHandler(ctx);
  registerVoiceStateHandler(ctx);

  client.once('clientReady', () => {
    fireAndForget(onReady(ctx), logger, LogEvent.MODERATION_ERROR, { stage: 'ready' });
  });

  client.on('error', (err) => {
    logger.error(LogEvent.DISCORD_VOICE_ERROR, { scope: 'client', err: toError(err) });
  });

  onDispose('voice sessions', () => voice.stop());
  onDispose('retention sweeper', () => sweeper.stop());

  installShutdownHandlers(logger);

  sweeper.start();
  // Prune anything that expired while the bot was down.
  fireAndForget(sweeper.sweep(), logger, LogEvent.EVIDENCE_ERROR, { stage: 'startup-sweep' });

  await client.login(config.discord.token);
}

function warnAboutRiskySettings(
  config: ReturnType<typeof loadEnv>,
  logger: Logger,
): void {
  if (config.stt.weakVerify) {
    logger.warn(LogEvent.CONFIG_LOADED, {
      model: config.stt.model,
      message:
        'The verify pass uses the same provider and model as the primary pass. Re-running identical ' +
        'audio through identical weights reproduces the same errors, so low-confidence confirmation ' +
        'is much weaker than it appears. Set STT_VERIFY_MODEL to a different model.',
    });
  }

  if (!config.moderation.dryRun) {
    logger.warn(LogEvent.CONFIG_LOADED, {
      actionCeiling: config.moderation.actionCeiling,
      message: 'DRY_RUN is disabled — moderation actions will be applied to real users',
    });
  }

  if (config.moderation.allowUnattendedBan) {
    logger.warn(LogEvent.CONFIG_LOADED, {
      message:
        'ALLOW_UNATTENDED_BAN is enabled: users may be permanently banned on the basis of an ' +
        'automated transcription, with no human review.',
    });
  }

  if (config.evidence.enabled) {
    logger.warn(LogEvent.CONFIG_LOADED, {
      retentionDays: config.evidence.retentionDays,
      directory: config.evidence.directory,
      message:
        'Violation audio logging is enabled. Recordings of individual voices are treated as ' +
        'biometric data in some jurisdictions — see docs/PRIVACY.md.',
    });
  }

  if (!config.privacy.requireMonitoringNotice) {
    logger.warn(LogEvent.CONFIG_LOADED, {
      message:
        'REQUIRE_MONITORING_NOTICE is disabled. Participants will not be told their speech is ' +
        'being transcribed. Ensure you are informing them another way.',
    });
  }
}

function installShutdownHandlers(logger: Logger): void {
  let shuttingDown = false;

  const shutdown = (signal: string, code = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(LogEvent.BOT_SHUTDOWN, { signal });

    void (async () => {
      await disposeAll(logger);
      exitWhenDrained(code);
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error(LogEvent.MODERATION_ERROR, {
      scope: 'unhandledRejection',
      err: toError(reason),
    });
  });

  process.on('uncaughtException', (err) => {
    logger.error(LogEvent.MODERATION_ERROR, { scope: 'uncaughtException', err });
    shutdown('uncaughtException', 1);
  });
}

main().catch(async (err: unknown) => {
  const error = toError(err);

  if (error instanceof ConfigError) {
    // Configuration problems are the operator's to fix, and a stack trace
    // helps nobody read them.
    process.stderr.write(`\n${error.message}\n\n`);
  } else if (isInvalidTokenError(error)) {
    // Overwhelmingly the most common startup failure. Say what to do about it
    // rather than printing a websocket stack trace.
    process.stderr.write(
      `\nDiscord rejected the bot token.\n\n` +
        `  • DISCORD_TOKEN may be wrong, or was reset in the Developer Portal.\n` +
        `  • Copy it from Developer Portal → your app → Bot → Reset Token.\n` +
        `  • It is the *bot* token, not the application's client secret.\n\n` +
        `Run \`npm run doctor\` to confirm.\n\n`,
    );
  } else {
    process.stderr.write(`\nFatal startup error: ${error.stack ?? error.message}\n\n`);
  }

  // Close whatever was already opened before exiting.
  await disposeAll();
  exitWhenDrained(error instanceof ConfigError ? 78 : 1); // 78 = EX_CONFIG
});

/** discord.js reports the reason in `code`; `name` carries a bracketed suffix. */
function isInvalidTokenError(error: Error): boolean {
  return (error as { code?: unknown }).code === 'TokenInvalid';
}
