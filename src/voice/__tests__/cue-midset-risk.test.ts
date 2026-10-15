// VMCP_CUES_MIDSET=risk keeps the legacy cue emitter silent mid-set (VW-614).
//
// Only the cue-delivery layer can speak mid-set under `risk`; the legacy emitter
// reads `midSetEnabled`, which `risk` leaves false.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { CueEmitter } = await import('../cue-emitter.js');

import type { ChannelEvent } from '../../state/channel-publisher.js';
import type { ToolResult } from '../../tools/helpers.js';
import type { SpeakDeps } from '../../tools/tts-tools.js';
import { applyMidSetMode, makeCueSettings, type CueSettings } from '../cue-settings.js';
import { CueSelector } from '../cue-templates.js';

const speakDeps: SpeakDeps = {
  platform: 'darwin',
  spawn: (() => undefined) as unknown as SpeakDeps['spawn'],
};

function event(eventType: string, meta: Record<string, string>): ChannelEvent {
  return { meta: { event_type: eventType, set_id: 's1', ...meta }, content: '{}' };
}

const setStarted = () => event('set_started', { weight_lbs: '40' });
const setEnded = () => event('set_ended', { rep_count: '8', duration_ms: '40000' });
const targetHit = () =>
  event('set_target_reached', { target_rep_count: '8', actual_rep_count: '8' });
const slowdown = () =>
  event('velocity_loss_exceeded', { velocity_loss_pct: '25.0', rep_count_at_threshold: '5' });

function emitterWith(settings: CueSettings) {
  const speak = vi.fn(() => Promise.resolve({ content: [] } as unknown as ToolResult));
  const emitter = new CueEmitter({
    speakDeps,
    speak: speak as never,
    selector: new CueSelector({ rng: () => 0 }),
    settings,
  });
  return { emitter, speak };
}

describe('VMCP_CUES_MIDSET=risk and the legacy cue emitter', () => {
  it('seeds settings with the risk mode and the legacy mid-set switch off', () => {
    expect(makeCueSettings({ cues: 'on', cuesMidSet: 'risk' })).toEqual({
      enabled: true,
      midSetEnabled: false,
      midSetMode: 'risk',
    });
  });

  it('drops target_hit and slowdown', () => {
    const { emitter, speak } = emitterWith(makeCueSettings({ cues: 'on', cuesMidSet: 'risk' }));

    emitter.onEvent(targetHit());
    emitter.onEvent(slowdown());

    expect(speak).not.toHaveBeenCalled();
  });

  it('still speaks the set-boundary cues', () => {
    const { emitter, speak } = emitterWith(makeCueSettings({ cues: 'on', cuesMidSet: 'risk' }));

    emitter.onEvent(setStarted());
    emitter.onEvent(setEnded());

    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('goes silent mid-set when the mode moves from on to risk at runtime', () => {
    const settings = makeCueSettings({ cues: 'on', cuesMidSet: 'on' });
    const { emitter, speak } = emitterWith(settings);

    applyMidSetMode(settings, 'risk');
    emitter.onEvent(targetHit());
    emitter.onEvent(slowdown());

    expect(speak).not.toHaveBeenCalled();
  });
});
