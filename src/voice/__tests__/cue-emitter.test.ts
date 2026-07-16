// Unit tests for the deterministic cue emitter + tee (VMCP-02.79, PR4).
//
// cue-emitter imports tts-tools (macOS `say` wrapper), so we stub the SDK the
// same way tts-tools.test does and dynamic-import the module under test.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { CueEmitter, CueTeePublisher } = await import('../cue-emitter.js');

import { CueSelector } from '../cue-templates.js';
import type { ChannelEvent, ChannelPublisher } from '../../state/channel-publisher.js';
import type { SpeakDeps } from '../../tools/tts-tools.js';
import type { ToolResult } from '../../tools/helpers.js';

// Deterministic deps: fixed rng (always first candidate) + a spy speak. The
// dummy spawn is never reached because speak is injected.
const speakDeps: SpeakDeps = {
  platform: 'darwin',
  spawn: (() => undefined) as unknown as SpeakDeps['spawn'],
};

function makeSpeakSpy(): ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.resolve({ content: [] } as unknown as ToolResult));
}

function makeEmitter(speakSpy: ReturnType<typeof vi.fn>, deps: Partial<SpeakDeps> = {}) {
  return new CueEmitter({
    speakDeps: { ...speakDeps, ...deps },
    speak: speakSpy as never,
    selector: new CueSelector({ rng: () => 0 }),
  });
}

function event(
  eventType: string,
  meta: Record<string, string>,
  content: unknown = {},
): ChannelEvent {
  return { meta: { event_type: eventType, ...meta }, content: JSON.stringify(content) };
}

const setStarted = () =>
  event(
    'set_started',
    { set_id: 's1', weight_lbs: '100' },
    { summary: 'Set started: 100 lbs WeightTraining (set 3 of session)' },
  );
const setEnded = () => event('set_ended', { set_id: 's1', rep_count: '8', duration_ms: '45000' });
const velocityLoss = () =>
  event('velocity_loss_exceeded', {
    set_id: 's1',
    velocity_loss_pct: '25.0',
    rep_count_at_threshold: '5',
  });

function spokenText(spy: ReturnType<typeof vi.fn>, call = 0): string {
  return (spy.mock.calls[call]![0] as { text: string }).text;
}
function spokenInterrupt(spy: ReturnType<typeof vi.fn>, call = 0): boolean {
  return (spy.mock.calls[call]![0] as { interrupt: boolean }).interrupt;
}

describe('CueEmitter', () => {
  it('speaks a non-urgent set-intro cue for set_started', () => {
    const speakSpy = makeSpeakSpy();
    makeEmitter(speakSpy).onEvent(setStarted());
    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(spokenText(speakSpy)).not.toContain('${');
    expect(spokenInterrupt(speakSpy)).toBe(false);
  });

  it('speaks an urgent (interrupting) cue for velocity_loss_exceeded', () => {
    const speakSpy = makeSpeakSpy();
    makeEmitter(speakSpy).onEvent(velocityLoss());
    expect(speakSpy).toHaveBeenCalledTimes(1);
    expect(spokenInterrupt(speakSpy)).toBe(true);
  });

  it('renders slot values into the spoken text', () => {
    const speakSpy = makeSpeakSpy();
    makeEmitter(speakSpy).onEvent(setEnded());
    // Every set_complete template references ${reps}; rep_count is 8.
    expect(spokenText(speakSpy)).toContain('8');
    expect(spokenText(speakSpy)).not.toContain('${');
  });

  it('does not speak for non-cue events', () => {
    const speakSpy = makeSpeakSpy();
    makeEmitter(speakSpy).onEvent(event('rep_finalized', { set_id: 's1', rep_number: '3' }));
    expect(speakSpy).not.toHaveBeenCalled();
  });

  it('speaks a category at most once per set', () => {
    const speakSpy = makeSpeakSpy();
    const emitter = makeEmitter(speakSpy);
    emitter.onEvent(setStarted());
    emitter.onEvent(setStarted());
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it('speaks again for the same category on a different set', () => {
    const speakSpy = makeSpeakSpy();
    const emitter = makeEmitter(speakSpy);
    emitter.onEvent(setStarted());
    emitter.onEvent(event('set_started', { set_id: 's2', weight_lbs: '110' }, {}));
    expect(speakSpy).toHaveBeenCalledTimes(2);
  });

  it('is a no-op on non-macOS hosts', () => {
    const speakSpy = makeSpeakSpy();
    makeEmitter(speakSpy, { platform: 'linux' }).onEvent(setStarted());
    expect(speakSpy).not.toHaveBeenCalled();
  });
});

// Minimal ChannelPublisher spy that records passthrough and supports forSlot.
function makeInnerSpy(): ChannelPublisher & { published: ChannelEvent[]; slotOf: string[] } {
  const published: ChannelEvent[] = [];
  const slotOf: string[] = [];
  const self: ChannelPublisher & { published: ChannelEvent[]; slotOf: string[] } = {
    published,
    slotOf,
    publish: (e) => published.push(e),
    forSlot: (slotId) => {
      slotOf.push(slotId);
      return self;
    },
  };
  return self;
}

describe('CueTeePublisher', () => {
  it('forwards every event to the inner publisher (cue and non-cue)', () => {
    const inner = makeInnerSpy();
    const speakSpy = makeSpeakSpy();
    const tee = new CueTeePublisher(inner, makeEmitter(speakSpy));
    tee.publish(setStarted());
    tee.publish(event('rep_finalized', { set_id: 's1' }));
    expect(inner.published).toHaveLength(2);
  });

  it('speaks cues while passing through', () => {
    const inner = makeInnerSpy();
    const speakSpy = makeSpeakSpy();
    new CueTeePublisher(inner, makeEmitter(speakSpy)).publish(setStarted());
    expect(inner.published).toHaveLength(1);
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it('never lets a cue failure break channel delivery', () => {
    const inner = makeInnerSpy();
    const throwingSpeak = vi.fn(() => {
      throw new Error('boom');
    });
    const tee = new CueTeePublisher(inner, makeEmitter(throwingSpeak));
    expect(() => tee.publish(setStarted())).not.toThrow();
    expect(inner.published).toHaveLength(1);
  });

  it('forSlot returns a tee that still passes through and tees', () => {
    const inner = makeInnerSpy();
    const speakSpy = makeSpeakSpy();
    const slotTee = new CueTeePublisher(inner, makeEmitter(speakSpy)).forSlot('primary');
    slotTee.publish(setStarted());
    expect(inner.slotOf).toEqual(['primary']);
    expect(inner.published).toHaveLength(1);
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });
});
