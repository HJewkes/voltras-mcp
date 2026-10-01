import { describe, expect, it, vi } from 'vitest';

import type { ChannelEvent, ChannelPublisher } from '../../../state/channel-publisher.js';
import type { Tier } from '../../../tools/tier-signal.js';
import { CueSelector } from '../../cue-templates.js';
import {
  DeliveryEmitter,
  DeliveryTee,
  type DeliveryEmitterDeps,
  type DeliveryRecord,
  type SpeakRequest,
} from '../delivery-emitter.js';
import { readSetFaults } from '../focus-select.js';
import { focusPhrase } from '../focus-phrases.js';
import {
  ended,
  reps,
  SHRINKING_RANGE_REPS,
  slowdown,
  started,
  STEADY_REPS,
  targetReached,
} from './delivery-fixtures.js';

const TIERS: Tier[] = ['beginner', 'intermediate', 'advanced'];
const AFFIRMING = focusPhrase('full_range', 'affirming');
const DIRECTIVE = focusPhrase('full_range', 'directive');

interface Spoken {
  text: string;
  source: string;
  interrupt: boolean;
}

interface Harness {
  emitter: DeliveryEmitter;
  spoken: Spoken[];
  records: DeliveryRecord[];
}

function harness(overrides: Partial<DeliveryEmitterDeps> & { tier?: Tier } = {}): Harness {
  const spoken: Spoken[] = [];
  const records: DeliveryRecord[] = [];
  const { tier = 'beginner', ...deps } = overrides;
  const emitter = new DeliveryEmitter({
    speak: (request: SpeakRequest, source: string) => {
      spoken.push({ text: request.text, source, interrupt: request.interrupt });
      return Promise.resolve();
    },
    platform: 'darwin',
    clock: () => 1_000,
    settings: { enabled: true, midSetEnabled: true },
    selector: new CueSelector({ rng: () => 0 }),
    tierFor: () => Promise.resolve(tier),
    exerciseFor: () => 'row',
    repsFor: ({ setId }) => (setId === 'warm' ? SHRINKING_RANGE_REPS : STEADY_REPS),
    onDecision: (record) => records.push(record),
    ...deps,
  });
  return { emitter, spoken, records };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Publish events in one tick, as the bridge does for a rep and its triggers, then settle. */
async function tick(h: Harness, ...events: ChannelEvent[]): Promise<void> {
  for (const event of events) h.emitter.onEvent(event);
  await settle();
}

async function eachTick(h: Harness, events: ChannelEvent[]): Promise<void> {
  for (const event of events) await tick(h, event);
}

/** A first set whose range shrinks, so the working set carries the full_range focus. */
async function warmUp(h: Harness): Promise<void> {
  await tick(h, started('warm'));
  await eachTick(h, reps('warm', 5));
  await tick(h, ended('warm', SHRINKING_RANGE_REPS));
}

function intraLines(h: Harness, setId = 'work'): DeliveryRecord[] {
  return h.records.filter(
    (record) => record.setId === setId && record.interval === 'intra' && record.decision.admit,
  );
}

describe('DeliveryEmitter', () => {
  it('reads a focus from the warm-up fixture', () => {
    expect(readSetFaults(SHRINKING_RANGE_REPS)).toEqual(['full_range']);
    expect(readSetFaults(STEADY_REPS)).toEqual([]);
  });

  it('speaks no intra-set line to an advanced lifter', async () => {
    const h = harness({ tier: 'advanced' });
    await warmUp(h);
    await tick(h, started('work'));
    await eachTick(h, reps('work', 8));
    await tick(h, targetReached('work', 8), slowdown('work', 8));

    expect(intraLines(h)).toEqual([]);
    expect(h.spoken.map((line) => line.text)).toContain(AFFIRMING);
  });

  it('gives a beginner at most two intra-set lines, both the pre-set focus', async () => {
    const h = harness({ tier: 'beginner' });
    await warmUp(h);
    await tick(h, started('work'));
    await eachTick(h, reps('work', 10));

    const lines = intraLines(h);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.line)).toEqual([
      { kind: 'focus', focusId: 'full_range' },
      { kind: 'focus', focusId: 'full_range' },
    ]);
    expect(lines.map((line) => line.text)).toEqual([AFFIRMING, AFFIRMING]);
  });

  it('states the intro and then the focus before the set', async () => {
    const h = harness();
    await warmUp(h);
    await tick(h, started('work'));

    const pre = h.records.filter((r) => r.setId === 'work' && r.interval === 'pre');
    expect(pre.map((r) => r.line.kind)).toEqual(['announcement', 'focus']);
    expect(h.spoken.at(-1)).toEqual({ text: AFFIRMING, source: 'focus', interrupt: false });
  });

  it('switches later reminders to the directive phrase once velocity loss fires', async () => {
    const h = harness({ tier: 'beginner' });
    await warmUp(h);
    await tick(h, started('work'));
    const [first, second, third] = reps('work', 3);
    await tick(h, first, slowdown('work', 1));
    await eachTick(h, [second, third]);

    const [loss, reminder] = intraLines(h);
    expect(loss?.line).toEqual({ kind: 'announcement', category: 'slowdown' });
    expect(reminder?.text).toBe(DIRECTIVE);
  });

  it('keeps reminders affirming when nothing reads near failure', async () => {
    const h = harness({ tier: 'beginner' });
    await warmUp(h);
    await tick(h, started('work'));
    await eachTick(h, reps('work', 2));

    expect(intraLines(h).map((line) => line.text)).toEqual([AFFIRMING]);
  });

  it('turns directive on the effort resolver reading, not the rep stream', async () => {
    const effort = { cueState: 'approaching', confidence: 'high', rir: 1 } as const;
    const h = harness({ tier: 'beginner', signalsFor: () => ({ effort }) });
    await warmUp(h);
    await tick(h, started('work'));
    await eachTick(h, reps('work', 2));

    expect(intraLines(h).map((line) => line.text)).toEqual([DIRECTIVE]);
  });

  it.each(TIERS)('speaks no intra-set line to a %s lifter with mid-set cues off', async (tier) => {
    const h = harness({ tier, settings: { enabled: true, midSetEnabled: false } });
    await warmUp(h);
    await tick(h, started('work'));
    await eachTick(h, reps('work', 8));
    await tick(h, targetReached('work', 8), slowdown('work', 8));

    expect(intraLines(h)).toEqual([]);
  });

  it.each([
    ['cues are off', { settings: { enabled: false, midSetEnabled: true } }],
    ['the host is not macOS', { platform: 'linux' as const }],
  ])('speaks nothing when %s', async (_, overrides) => {
    const h = harness(overrides);
    await warmUp(h);
    await tick(h, started('work'));
    await eachTick(h, reps('work', 6));
    await tick(h, slowdown('work', 6));
    await tick(h, ended('work', STEADY_REPS));

    expect(h.spoken).toEqual([]);
  });

  it('lets slowdown win over a reminder due on the same rep', async () => {
    const h = harness({ tier: 'intermediate' });
    await warmUp(h);
    await tick(h, started('work'));
    const [first, second, third, fourth] = reps('work', 4);
    await tick(h, first);
    await tick(h, second, slowdown('work', 2));
    await eachTick(h, [third, fourth]);

    const lines = intraLines(h);
    expect(lines.map((line) => line.line)).toEqual([
      { kind: 'announcement', category: 'slowdown' },
    ]);
    expect(h.spoken.find((line) => line.source === 'slowdown')?.interrupt).toBe(true);
  });

  it('spends the intra-set budget on announcements too', async () => {
    const h = harness({ tier: 'intermediate' });
    await tick(h, started('work'));
    await tick(h, ...reps('work', 1), slowdown('work', 1));
    await tick(h, ...reps('work', 1, 2), targetReached('work', 2));

    const refused = h.records.filter((r) => r.interval === 'intra' && !r.decision.admit);
    expect(intraLines(h).map((line) => line.line)).toEqual([
      { kind: 'announcement', category: 'slowdown' },
    ]);
    expect(refused.map((r) => r.decision.reason)).toEqual(['tier_density']);
  });

  it('lets a due reminder win over target_hit', async () => {
    const h = harness({ tier: 'beginner' });
    await warmUp(h);
    await tick(h, started('work'));
    const [first, second] = reps('work', 2);
    await tick(h, first);
    await tick(h, second, targetReached('work', 2));

    expect(intraLines(h).map((line) => line.line)).toEqual([
      { kind: 'focus', focusId: 'full_range' },
    ]);
  });

  it('holds the strictest density until the tier lookup resolves', async () => {
    let resolveTier: (tier: Tier) => void = () => undefined;
    const pending = new Promise<Tier>((resolve) => {
      resolveTier = resolve;
    });
    const h = harness({ tierFor: () => pending });
    await warmUp(h);
    await tick(h, started('work'));
    await eachTick(h, reps('work', 2));
    expect(intraLines(h)).toEqual([]);

    resolveTier('beginner');
    await eachTick(h, reps('work', 2, 3));
    expect(intraLines(h).map((line) => line.text)).toEqual([AFFIRMING]);
  });

  it('stays at the strictest density when the tier lookup fails', async () => {
    const h = harness({ tierFor: () => Promise.reject(new Error('no profile')) });
    await warmUp(h);
    await tick(h, started('work'));
    await eachTick(h, reps('work', 6));

    expect(intraLines(h)).toEqual([]);
  });

  it('reinforces a resolved focus after a clean set', async () => {
    const h = harness();
    await warmUp(h);
    await tick(h, started('work'));
    await eachTick(h, reps('work', 5));
    await tick(h, ended('work', STEADY_REPS));

    const post = h.records.filter((r) => r.setId === 'work' && r.interval === 'post');
    expect(post[0]?.text).toBe('Good, your range held all set.');
  });

  it('keeps bilateral slots on separate budgets', async () => {
    const h = harness({ tier: 'intermediate' });
    const onSlot = (slot: string, event: ChannelEvent): ChannelEvent => ({
      ...event,
      meta: { ...event.meta, slot },
    });
    await tick(h, onSlot('left', started('work')), onSlot('right', started('work')));
    await tick(h, onSlot('left', reps('work', 1)[0]!), onSlot('left', slowdown('work', 1)));
    await tick(h, onSlot('right', reps('work', 1)[0]!), onSlot('right', slowdown('work', 1)));

    expect(intraLines(h).map((line) => line.slot)).toEqual(['left', 'right']);
  });

  it('stamps each decision with the injected clock', async () => {
    const h = harness({ clock: () => 42 });
    await tick(h, started('work'));

    expect(h.records.map((record) => record.at)).toEqual([42]);
  });
});

describe('DeliveryTee', () => {
  function recordingPublisher(): ChannelPublisher & { published: ChannelEvent[] } {
    const published: ChannelEvent[] = [];
    const publisher = {
      published,
      publish: (event: ChannelEvent) => published.push(event),
      forSlot: (slot: string): ChannelPublisher => ({
        publish: (event) => published.push({ ...event, meta: { slot, ...event.meta } }),
        forSlot: () => publisher,
      }),
    };
    return publisher;
  }

  it('forwards every event to the inner publisher unchanged', async () => {
    const inner = recordingPublisher();
    const tee = new DeliveryTee(inner, harness().emitter);
    const events = [started('work'), ...reps('work', 3), slowdown('work', 3)];
    const snapshot = JSON.parse(JSON.stringify(events)) as ChannelEvent[];

    for (const event of events) tee.publish(event);
    await settle();

    expect(inner.published).toEqual(snapshot);
  });

  it('still forwards the event when the emitter throws', () => {
    const inner = recordingPublisher();
    const emitter = harness().emitter;
    vi.spyOn(emitter, 'onEvent').mockImplementation(() => {
      throw new Error('boom');
    });

    new DeliveryTee(inner, emitter).publish(started('work'));

    expect(inner.published).toHaveLength(1);
  });

  it('gives the emitter the slot of a slot-scoped tee', async () => {
    const inner = recordingPublisher();
    const h = harness({ tier: 'beginner' });
    const left = new DeliveryTee(inner, h.emitter).forSlot('left');

    left.publish(started('work'));
    await settle();

    expect(h.records.map((record) => record.slot)).toEqual(['left']);
    expect(inner.published[0]?.meta.slot).toBe('left');
  });
});
