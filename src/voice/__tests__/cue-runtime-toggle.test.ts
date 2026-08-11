// Runtime cue toggling (VMCP-02.85).
//
// Two structural properties are under test, and the ON-FROM-COLD case is the
// one that matters: before this change `maybeCueTee` returned the inner
// publisher unchanged when cues were off, so a server started with
// `VMCP_CUES=off` had no emitter in the pipeline at all and NOTHING could turn
// cues on short of restarting the whole Claude Code session. The second is that
// both switches are read per event rather than captured at construction.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

// `installCueTee` builds its own emitter with the real `speak`, so the
// end-to-end case below mocks the module rather than injecting a spy.
const tts = vi.hoisted(() => ({
  speak: vi.fn(() => Promise.resolve({ content: [] })),
}));
vi.mock('../../tools/tts-tools.js', () => tts);

const { CueEmitter, CueTeePublisher, installCueTee } = await import('../cue-emitter.js');

import type { CueSettings } from '../cue-settings.js';
import { CueSelector } from '../cue-templates.js';
import type { ChannelEvent, ChannelPublisher } from '../../state/channel-publisher.js';
import type { SpeakDeps } from '../../tools/tts-tools.js';
import type { ToolResult } from '../../tools/helpers.js';

function makeSpeakSpy(): ReturnType<typeof vi.fn> {
  return vi.fn(() => Promise.resolve({ content: [] } as unknown as ToolResult));
}

function makeInner(): ChannelPublisher & { published: ChannelEvent[] } {
  const published: ChannelEvent[] = [];
  const self: ChannelPublisher & { published: ChannelEvent[] } = {
    published,
    publish: (e) => published.push(e),
    forSlot: () => self,
  };
  return self;
}

/** The exact shape `installCueTee` builds, with speak + platform pinned. */
function makeTee(
  settings: CueSettings,
  speakSpy: ReturnType<typeof vi.fn>,
  platform: NodeJS.Platform = 'darwin',
): { tee: ChannelPublisher; inner: ChannelPublisher & { published: ChannelEvent[] } } {
  const inner = makeInner();
  const emitter = new CueEmitter({
    speakDeps: { platform, spawn: (() => undefined) as unknown as SpeakDeps['spawn'] },
    speak: speakSpy as never,
    selector: new CueSelector({ rng: () => 0 }),
    settings,
  });
  return { tee: new CueTeePublisher(inner, emitter), inner };
}

function event(eventType: string, meta: Record<string, string>): ChannelEvent {
  return { meta: { event_type: eventType, ...meta }, content: JSON.stringify({}) };
}

const setStarted = (setId = 's1') => event('set_started', { set_id: setId, weight_lbs: '100' });
const setEnded = (setId = 's1') =>
  event('set_ended', { set_id: setId, rep_count: '8', duration_ms: '45000' });
const targetHit = (setId = 's1') =>
  event('set_target_reached', {
    set_id: setId,
    target_rep_count: '8',
    actual_rep_count: '9',
  });
const slowdown = (setId = 's1') =>
  event('velocity_loss_exceeded', {
    set_id: setId,
    velocity_loss_pct: '25.0',
    rep_count_at_threshold: '5',
  });

describe('installCueTee', () => {
  it('installs the tee even when cues start OFF, so they can be turned on later', () => {
    // The whole point of VMCP-02.85: a publisher that was never wrapped can
    // never start cueing, whatever a settings toggle says afterwards.
    const inner = makeInner();
    const tee = installCueTee(inner, {
      settings: { enabled: false, midSetEnabled: false },
      voiceListenerRef: null,
    });
    expect(tee).not.toBe(inner);
    expect(tee).toBeInstanceOf(CueTeePublisher);
  });

  it('end-to-end: a tee built with cues OFF speaks once the switch is flipped', () => {
    // The full production path — `installCueTee` + its own emitter + the real
    // `speak` import (mocked here) — starting from the cold configuration.
    // `process.platform` is pinned so this is deterministic on CI too.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      tts.speak.mockClear();
      const settings: CueSettings = { enabled: false, midSetEnabled: false };
      const tee = installCueTee(makeInner(), { settings, voiceListenerRef: null });
      tee.publish(setStarted('s1'));
      expect(tts.speak).not.toHaveBeenCalled();

      settings.enabled = true;
      tee.publish(setStarted('s2'));

      expect(tts.speak).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('passes events through untouched while cues are off', () => {
    const inner = makeInner();
    const tee = installCueTee(inner, {
      settings: { enabled: false, midSetEnabled: false },
      voiceListenerRef: null,
    });
    const ev = setStarted();
    tee.publish(ev);
    expect(inner.published).toEqual([ev]);
  });
});

describe('cue master switch at runtime', () => {
  it('starting from cues OFF, turning them on produces cues with no restart', () => {
    // Arrange: a cold start with VMCP_CUES unset — the bench-sitting shape.
    const settings: CueSettings = { enabled: false, midSetEnabled: false };
    const speakSpy = makeSpeakSpy();
    const { tee } = makeTee(settings, speakSpy);
    tee.publish(setStarted('s1'));
    expect(speakSpy).not.toHaveBeenCalled();

    // Act: what `system.set_cues { cues: 'on' }` does.
    settings.enabled = true;
    tee.publish(setStarted('s2'));

    // Assert
    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it('a cue suppressed while off can still fire for the same set once on', () => {
    // Suppression must not consume the once-per-set budget, or turning cues on
    // mid-set would silently skip that set's categories.
    const settings: CueSettings = { enabled: false, midSetEnabled: false };
    const speakSpy = makeSpeakSpy();
    const { tee } = makeTee(settings, speakSpy);
    tee.publish(setStarted('s1'));

    settings.enabled = true;
    tee.publish(setStarted('s1'));

    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it('turning cues off at runtime silences subsequent cues', () => {
    const settings: CueSettings = { enabled: true, midSetEnabled: false };
    const speakSpy = makeSpeakSpy();
    const { tee } = makeTee(settings, speakSpy);
    tee.publish(setStarted('s1'));
    expect(speakSpy).toHaveBeenCalledTimes(1);

    settings.enabled = false;
    tee.publish(setStarted('s2'));

    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps passing every event through whichever way the switch is thrown', () => {
    const settings: CueSettings = { enabled: false, midSetEnabled: false };
    const { tee, inner } = makeTee(settings, makeSpeakSpy());
    tee.publish(setStarted('s1'));
    settings.enabled = true;
    tee.publish(setStarted('s2'));
    expect(inner.published).toHaveLength(2);
  });
});

describe('mid-set switch at runtime', () => {
  it('turning midSet off suppresses slowdown and target_hit', () => {
    const settings: CueSettings = { enabled: true, midSetEnabled: true };
    const speakSpy = makeSpeakSpy();
    const { tee } = makeTee(settings, speakSpy);

    settings.midSetEnabled = false;
    tee.publish(targetHit('s1'));
    tee.publish(slowdown('s1'));

    expect(speakSpy).not.toHaveBeenCalled();
  });

  it('turning midSet off leaves set_intro and set_complete speaking', () => {
    const settings: CueSettings = { enabled: true, midSetEnabled: true };
    const speakSpy = makeSpeakSpy();
    const { tee } = makeTee(settings, speakSpy);

    settings.midSetEnabled = false;
    tee.publish(setStarted('s1'));
    tee.publish(setEnded('s1'));

    expect(speakSpy).toHaveBeenCalledTimes(2);
  });

  it('turning midSet on arms slowdown and target_hit without a restart', () => {
    // The trial that would otherwise be silently unrunnable: slowdown under a
    // grind never fires when VMCP_CUES_MIDSET was missing at startup.
    const settings: CueSettings = { enabled: true, midSetEnabled: false };
    const speakSpy = makeSpeakSpy();
    const { tee } = makeTee(settings, speakSpy);
    tee.publish(slowdown('s1'));
    expect(speakSpy).not.toHaveBeenCalled();

    settings.midSetEnabled = true;
    tee.publish(slowdown('s2'));

    expect(speakSpy).toHaveBeenCalledTimes(1);
  });

  it('midSet on its own speaks nothing while the master switch is off', () => {
    const settings: CueSettings = { enabled: false, midSetEnabled: true };
    const speakSpy = makeSpeakSpy();
    const { tee } = makeTee(settings, speakSpy);
    tee.publish(setStarted('s1'));
    tee.publish(slowdown('s1'));
    expect(speakSpy).not.toHaveBeenCalled();
  });
});

describe('platform gate', () => {
  it('stays static — no toggle makes cues speak off macOS', () => {
    const settings: CueSettings = { enabled: false, midSetEnabled: false };
    const speakSpy = makeSpeakSpy();
    const { tee } = makeTee(settings, speakSpy, 'linux');

    settings.enabled = true;
    settings.midSetEnabled = true;
    tee.publish(setStarted('s1'));
    tee.publish(slowdown('s1'));

    expect(speakSpy).not.toHaveBeenCalled();
  });
});
