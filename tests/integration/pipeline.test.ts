import { beforeEach, describe, expect, it } from 'vitest';
import { ModerationPipeline } from '../../src/moderation/pipeline.js';
import type { ModerationEventContext } from '../../src/moderation/pipeline.js';
import { RecordingModerationAction } from '../../src/moderation/actions.js';
import { RulesetMatcher } from '../../src/moderation/matcher.js';
import { parseRuleset } from '../../src/moderation/rules.js';
import { MockSttProvider } from '../../src/speech/providers/mock.js';
import type { MockScriptEntry } from '../../src/speech/providers/mock.js';
import { CircuitBreaker, FairQueue } from '../../src/speech/queue.js';
import { TranscriptionService } from '../../src/speech/transcription-service.js';
import { MemoryModerationStore } from '../../src/storage/memory-store.js';
import { GuildSettingsService } from '../../src/storage/settings-store.js';
import { createNullLogger } from '../../src/observability/logger.js';
import { SttError } from '../../src/utils/errors.js';
import { TimestampedPcmRing } from '../../src/voice/ring-buffer.js';
import { DISCORD_SAMPLE_RATE } from '../../src/voice/pcm.js';
import type { EvidenceCaptureRequest, IEvidenceRecorder } from '../../src/evidence/types.js';
import type { EvidenceRecord } from '../../src/storage/types.js';
import type { AppConfig } from '../../src/config/types.js';
import { makeSegment } from '../helpers/segment.js';
import { testAppConfig, testModerationConfig } from '../helpers/config.js';

const RULES = [
  { id: 'rule-word', type: 'word', pattern: 'BANNEDWORDONE', severity: 'medium' },
  { id: 'rule-high', type: 'word', pattern: 'BANNEDWORDTWO', severity: 'high' },
];

/** Records what it was asked to capture, in order, without touching disk. */
class FakeEvidenceRecorder implements IEvidenceRecorder {
  readonly captures: EvidenceCaptureRequest[] = [];
  readonly order: string[] = [];

  constructor(
    readonly enabled = true,
    private readonly failWith?: Error,
  ) {}

  capture(request: EvidenceCaptureRequest): Promise<EvidenceRecord | undefined> {
    this.captures.push(request);
    this.order.push('evidence');
    if (this.failWith) return Promise.reject(this.failWith);

    return Promise.resolve({
      id: `evidence-${this.captures.length}`,
      createdAt: 0,
      expiresAt: 0,
      guildId: request.segment.guildId,
      channelId: request.segment.channelId,
      userId: request.segment.userId,
      segmentId: request.segment.segmentId,
      ruleId: request.ruleId,
      action: request.action,
      filename: 'x.wav',
      filePath: '/tmp/x.wav',
      durationMs: 100,
      byteSize: 200,
    });
  }
}

interface HarnessOptions {
  primaryScript?: MockScriptEntry[];
  verifyScript?: MockScriptEntry[];
  config?: Partial<AppConfig>;
  evidenceRecorder?: IEvidenceRecorder;
  breakerThreshold?: number;
}

async function makeHarness(opts: HarnessOptions = {}) {
  const logger = createNullLogger();
  const store = new MemoryModerationStore();
  await store.init();

  const config = testAppConfig(opts.config);
  const settings = new GuildSettingsService(store, config);
  const matcher = new RulesetMatcher(parseRuleset({ version: 1, rules: RULES }));

  const primary = new MockSttProvider({
    name: 'mock',
    ...(opts.primaryScript ? { script: opts.primaryScript } : { defaultText: '' }),
  });
  const verify = new MockSttProvider({
    name: 'mock-verify',
    ...(opts.verifyScript ? { script: opts.verifyScript } : { defaultText: '' }),
  });

  const queue = new FairQueue({ concurrency: 4, maxQueued: 32, logger });
  const breaker = new CircuitBreaker({
    threshold: opts.breakerThreshold ?? 5,
    resetMs: 60_000,
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

  const action = new RecordingModerationAction();
  const evidenceRecorder = opts.evidenceRecorder ?? new FakeEvidenceRecorder(false);
  const events: { event: Parameters<NonNullable<ConstructorParameters<typeof ModerationPipeline>[0]['onEvent']>>[0]; ctx: ModerationEventContext }[] = [];

  const actionOrder: string[] = [];
  const wrappedAction = {
    execute: (req: Parameters<typeof action.execute>[0]) => {
      actionOrder.push('action');
      if (evidenceRecorder instanceof FakeEvidenceRecorder) evidenceRecorder.order.push('action');
      return action.execute(req);
    },
  };

  const ring = new TimestampedPcmRing(DISCORD_SAMPLE_RATE, 20_000);

  const pipeline = new ModerationPipeline({
    getMatcher: () => matcher,
    transcription,
    store,
    settings,
    evidenceRecorder,
    action: wrappedAction,
    config,
    logger,
    resolveRing: (segment) => ({ ring, ownerUserId: segment.userId }),
    onEvent: (event, ctx) => events.push({ event, ctx }),
  });

  return { pipeline, action, store, settings, events, primary, verify, breaker, config, evidenceRecorder };
}

let harness: Awaited<ReturnType<typeof makeHarness>>;

describe('basic matching', () => {
  it('acts on a banned word and targets the speaker', async () => {
    harness = await makeHarness({ primaryScript: ['you said bannedwordone loudly'] });
    const segment = makeSegment({ userId: 'user-42' });

    await harness.pipeline.handleSegment(segment);

    expect(harness.action.requests).toHaveLength(1);
    expect(harness.action.requests[0].userId).toBe('user-42');
    expect(harness.action.requests[0].action).toBe('disconnect');
    expect(harness.events).toHaveLength(1);
    expect(harness.events[0].event.ruleId).toBe('rule-word');
  });

  it('does nothing for clean speech', async () => {
    harness = await makeHarness({ primaryScript: ['a perfectly ordinary sentence'] });
    await harness.pipeline.handleSegment(makeSegment());

    expect(harness.action.requests).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(await harness.store.listEvents({})).toHaveLength(0);
  });

  it('records the event with correct identity fields', async () => {
    harness = await makeHarness({ primaryScript: ['bannedwordone'] });
    const segment = makeSegment({ userId: 'u7', guildId: 'guild-1', channelId: 'chan-9' });

    await harness.pipeline.handleSegment(segment);

    const [event] = await harness.store.listEvents({});
    expect(event.userId).toBe('u7');
    expect(event.guildId).toBe('guild-1');
    expect(event.channelId).toBe('chan-9');
    expect(event.segmentId).toBe(segment.segmentId);
    expect(event.actionTaken).toBe(true);
  });

  it('picks the most severe rule when several match', async () => {
    harness = await makeHarness({ primaryScript: ['bannedwordone and bannedwordtwo'] });
    await harness.pipeline.handleSegment(makeSegment());

    expect(harness.events[0].event.ruleId).toBe('rule-high');
    expect(harness.events[0].event.severity).toBe('high');
  });

  it('does nothing when moderation is disabled for the guild', async () => {
    harness = await makeHarness({ primaryScript: ['bannedwordone'] });
    await harness.settings.update('guild-1', { moderationEnabled: false });

    await harness.pipeline.handleSegment(makeSegment({ guildId: 'guild-1' }));
    expect(harness.action.requests).toHaveLength(0);
  });
});

describe('dry run', () => {
  it('records the decision without applying it', async () => {
    harness = await makeHarness({
      primaryScript: ['bannedwordone'],
      config: { moderation: testModerationConfig({ dryRun: true }) },
    });

    await harness.pipeline.handleSegment(makeSegment());

    expect(harness.action.requests).toHaveLength(1);
    expect(harness.action.requests[0].dryRun).toBe(true);

    const [event] = await harness.store.listEvents({});
    expect(event.dryRun).toBe(true);
    expect(event.actionTaken).toBe(false);
  });
});

describe('confidence and verification', () => {
  it('skips the verify pass when confidence is high', async () => {
    harness = await makeHarness({
      primaryScript: [{ text: 'bannedwordone', confidence: 0.95 }],
      verifyScript: ['bannedwordone'],
    });

    await harness.pipeline.handleSegment(makeSegment());

    expect(harness.verify.callCount).toBe(0);
    expect(harness.action.requests).toHaveLength(1);
  });

  it('acts when a low-confidence match is confirmed by the verify model', async () => {
    harness = await makeHarness({
      primaryScript: [{ text: 'bannedwordone', confidence: 0.2 }],
      verifyScript: [{ text: 'yes bannedwordone', confidence: 0.9 }],
    });

    await harness.pipeline.handleSegment(makeSegment());

    expect(harness.verify.callCount).toBe(1);
    expect(harness.action.requests).toHaveLength(1);
    expect(harness.events[0].event.verified).toBe(true);
  });

  it('takes no action when the verify pass disagrees', async () => {
    harness = await makeHarness({
      primaryScript: [{ text: 'bannedwordone', confidence: 0.2 }],
      verifyScript: [{ text: 'banned word one, actually innocuous', confidence: 0.9 }],
    });

    await harness.pipeline.handleSegment(makeSegment());

    expect(harness.action.requests).toHaveLength(0);

    // The near-miss is still recorded so moderators can see it.
    const [event] = await harness.store.listEvents({});
    expect(event.actionTaken).toBe(false);
    expect(event.verified).toBe(false);
    expect(event.failureReason).toBe('verify-disagreed');
  });

  it('treats a null confidence as needing verification', async () => {
    // "Unknown" is not the same as "confident".
    harness = await makeHarness({
      primaryScript: [{ text: 'bannedwordone', confidence: null }],
      verifyScript: [{ text: 'bannedwordone', confidence: 0.9 }],
    });

    await harness.pipeline.handleSegment(makeSegment());
    expect(harness.verify.callCount).toBe(1);
    expect(harness.action.requests).toHaveLength(1);
  });

  it('takes no action when verification itself fails', async () => {
    harness = await makeHarness({
      primaryScript: [{ text: 'bannedwordone', confidence: 0.2 }],
      verifyScript: [new SttError('verify provider down', false)],
    });

    await harness.pipeline.handleSegment(makeSegment());

    expect(harness.action.requests).toHaveLength(0);
    const [event] = await harness.store.listEvents({});
    expect(event.failureReason).toBe('verify-failed');
  });
});

describe('speech-to-text failures are fail-safe', () => {
  it('takes no action when transcription fails', async () => {
    harness = await makeHarness({ primaryScript: [new SttError('provider down', false)] });
    await harness.pipeline.handleSegment(makeSegment());

    expect(harness.action.requests).toHaveLength(0);
    expect(await harness.store.listEvents({})).toHaveLength(0);
  });

  it('takes no action while the circuit breaker is open', async () => {
    harness = await makeHarness({
      primaryScript: [
        new SttError('down', false),
        new SttError('down', false),
        'bannedwordone',
      ],
      breakerThreshold: 2,
    });

    await harness.pipeline.handleSegment(makeSegment());
    await harness.pipeline.handleSegment(makeSegment());
    expect(harness.breaker.isOpen).toBe(true);

    // Even though the next script entry is a violation, nothing is requested.
    await harness.pipeline.handleSegment(makeSegment());
    expect(harness.action.requests).toHaveLength(0);
  });

  it('takes no action on an empty transcript', async () => {
    harness = await makeHarness({ primaryScript: [''] });
    await harness.pipeline.handleSegment(makeSegment());
    expect(harness.action.requests).toHaveLength(0);
  });
});

describe('deduplication', () => {
  it('acts once when the same segment is processed twice', async () => {
    harness = await makeHarness({ primaryScript: ['bannedwordone', 'bannedwordone'] });
    const segment = makeSegment();

    await harness.pipeline.handleSegment(segment);
    await harness.pipeline.handleSegment(segment);

    expect(harness.action.requests).toHaveLength(1);
  });

  it('acts once for equivalent transcripts in different segments within the window', async () => {
    harness = await makeHarness({ primaryScript: ['bannedwordone', 'bannedwordone'] });

    await harness.pipeline.handleSegment(makeSegment({ userId: 'u1' }));
    await harness.pipeline.handleSegment(makeSegment({ userId: 'u1' }));

    expect(harness.action.requests).toHaveLength(1);
  });

  it('does not let one user’s violation suppress another’s', async () => {
    harness = await makeHarness({ primaryScript: ['bannedwordone', 'bannedwordone'] });

    await harness.pipeline.handleSegment(makeSegment({ userId: 'user-a' }));
    await harness.pipeline.handleSegment(makeSegment({ userId: 'user-b' }));

    expect(harness.action.requests.map((r) => r.userId)).toEqual(['user-a', 'user-b']);
  });
});

describe('simultaneous speakers', () => {
  it('attributes concurrent segments to the right users', async () => {
    harness = await makeHarness({
      primaryScript: [
        { text: 'bannedwordone from alice' },
        { text: 'bannedwordone from bob' },
        { text: 'bannedwordone from carol' },
      ],
    });

    const segments = [
      makeSegment({ userId: 'alice' }),
      makeSegment({ userId: 'bob' }),
      makeSegment({ userId: 'carol' }),
    ];

    await Promise.all(segments.map((s) => harness.pipeline.handleSegment(s)));

    expect(harness.action.requests).toHaveLength(3);
    expect(harness.action.requests.map((r) => r.userId).sort()).toEqual(['alice', 'bob', 'carol']);

    // Every recorded event must pair the right user with the right segment.
    const events = await harness.store.listEvents({});
    for (const event of events) {
      const segment = segments.find((s) => s.segmentId === event.segmentId);
      expect(segment).toBeDefined();
      expect(event.userId).toBe(segment!.userId);
    }
  });

  it('keeps a clean speaker unaffected by a violating one', async () => {
    harness = await makeHarness({
      primaryScript: [{ text: 'bannedwordone' }, { text: 'nothing wrong here' }],
    });

    await Promise.all([
      harness.pipeline.handleSegment(makeSegment({ userId: 'guilty' })),
      harness.pipeline.handleSegment(makeSegment({ userId: 'innocent' })),
    ]);

    expect(harness.action.requests).toHaveLength(1);
    expect(harness.action.requests[0].userId).toBe('guilty');
  });
});

describe('evidence', () => {
  it('captures evidence before executing the action', async () => {
    // Ordering matters: disconnecting the speaker tears down the stream that
    // holds their audio.
    const recorder = new FakeEvidenceRecorder(true);
    harness = await makeHarness({ primaryScript: ['bannedwordone'], evidenceRecorder: recorder });

    await harness.pipeline.handleSegment(makeSegment());

    expect(recorder.order).toEqual(['evidence', 'action']);
    expect(harness.events[0].event.evidenceId).toBe('evidence-1');
  });

  it('hands the recorder the segment’s own speaker', async () => {
    const recorder = new FakeEvidenceRecorder(true);
    harness = await makeHarness({ primaryScript: ['bannedwordone'], evidenceRecorder: recorder });

    await harness.pipeline.handleSegment(makeSegment({ userId: 'user-x' }));

    expect(recorder.captures[0].ownerUserId).toBe('user-x');
    expect(recorder.captures[0].segment.userId).toBe('user-x');
  });

  it('still applies the action when evidence capture fails', async () => {
    const recorder = new FakeEvidenceRecorder(true, new Error('disk full'));
    harness = await makeHarness({ primaryScript: ['bannedwordone'], evidenceRecorder: recorder });

    await harness.pipeline.handleSegment(makeSegment());

    expect(harness.action.requests).toHaveLength(1);
    expect(harness.events[0].event.evidenceId).toBeUndefined();
  });

  it('captures nothing when the recorder is disabled', async () => {
    const recorder = new FakeEvidenceRecorder(false);
    harness = await makeHarness({ primaryScript: ['bannedwordone'], evidenceRecorder: recorder });

    await harness.pipeline.handleSegment(makeSegment());

    expect(recorder.captures).toHaveLength(0);
    expect(harness.action.requests).toHaveLength(1);
  });
});

describe('escalation and ban gating', () => {
  it('climbs the ladder across repeat offences', async () => {
    harness = await makeHarness({
      primaryScript: ['bannedwordone', 'bannedwordone', 'bannedwordone'],
      config: {
        moderation: testModerationConfig({
          escalationEnabled: true,
          actionCeiling: 'ban',
          dedupeTtlMs: 0,
        }),
      },
    });

    for (let i = 0; i < 3; i++) {
      await harness.pipeline.handleSegment(makeSegment({ userId: 'repeat-offender' }));
    }

    expect(harness.action.requests.map((r) => r.action)).toEqual([
      'warn',
      'disconnect',
      'kick',
    ]);
  });

  it('downgrades an unattended ban to a kick and flags it', async () => {
    harness = await makeHarness({
      primaryScript: Array(5).fill('bannedwordone'),
      config: {
        moderation: testModerationConfig({
          escalationEnabled: true,
          actionCeiling: 'ban',
          allowUnattendedBan: false,
          dedupeTtlMs: 0,
        }),
      },
    });

    for (let i = 0; i < 5; i++) {
      await harness.pipeline.handleSegment(makeSegment({ userId: 'repeat-offender' }));
    }

    const last = harness.action.requests[harness.action.requests.length - 1];
    expect(last.action).toBe('kick');
    expect(harness.events[harness.events.length - 1].ctx.banWithheld).toBe(true);
  });
});

describe('privacy', () => {
  it('stores only a transcript hash by default', async () => {
    harness = await makeHarness({ primaryScript: ['bannedwordone said out loud'] });
    await harness.pipeline.handleSegment(makeSegment());

    const [event] = await harness.store.listEvents({});
    expect(event.transcript).toBeUndefined();
    expect(event.matchedText).toBeUndefined();
    expect(event.transcriptHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stores the transcript when logging is explicitly enabled', async () => {
    harness = await makeHarness({
      primaryScript: ['bannedwordone said out loud'],
      config: { privacy: { requireMonitoringNotice: true, transcriptLogging: true } },
    });

    await harness.pipeline.handleSegment(makeSegment());

    const [event] = await harness.store.listEvents({});
    expect(event.transcript).toBe('bannedwordone said out loud');
    expect(event.matchedText).toBe('bannedwordone');
  });
});

describe('resilience', () => {
  it('never throws out of handleSegment', async () => {
    harness = await makeHarness({ primaryScript: [new Error('unexpected explosion')] });
    await expect(harness.pipeline.handleSegment(makeSegment())).resolves.toBeUndefined();
  });

  it('survives a store that rejects writes', async () => {
    harness = await makeHarness({ primaryScript: ['bannedwordone'] });
    harness.store.recordEvent = () => Promise.reject(new Error('database is down'));

    await expect(harness.pipeline.handleSegment(makeSegment())).resolves.toBeUndefined();
    // The action still happened; only the bookkeeping failed.
    expect(harness.action.requests).toHaveLength(1);
  });
});

beforeEach(() => {
  harness = undefined as never;
});
