// Chooses the cue layer behind VMCP_CUE_DELIVERY (VW-140 plan slice S6).
//
// Exactly one tee is installed, so a line can never be spoken by both layers. Either
// way the tee is always installed, because `system.set_cues` must be able to turn
// cues on later (VMCP-02.85).

import { spawn } from 'node:child_process';

import type { Config } from '../../config.js';
import type { ChannelPublisher } from '../../state/channel-publisher.js';
import { getTierSignal, type Tier, type TierSignalState } from '../../tools/tier-signal.js';
import {
  speak,
  type CoachLineSink,
  type SpeakDeps,
  type VoiceListenerRef,
} from '../../tools/tts-tools.js';
import { LOCAL_USER_ID } from '../../store/types.js';
import { installCueTee } from '../cue-emitter.js';
import type { CueSettings } from '../cue-settings.js';
import { CueSelector } from '../cue-templates.js';
import { DeliveryEmitter, DeliveryTee, type SetContext } from './delivery-emitter.js';
import { exerciseOf, lifterOf, repsOf, signalsOf, type SetLookupLive } from './set-lookups.js';

/** The slice of server state the cue layer reads; `ServerState` satisfies it. */
export interface CueLayerState extends TierSignalState {
  config: Pick<Config, 'cueDelivery'>;
  slots: ReadonlyMap<string, { live: SetLookupLive }>;
}

export interface CueLayerOptions {
  /** Live settings object, shared with `system.set_cues`. */
  settings: CueSettings;
  voiceListenerRef: VoiceListenerRef | null;
  coachLine?: CoachLineSink | null;
  /** Injectable for tests; defaults to the host platform. */
  platform?: NodeJS.Platform;
}

export function installCueLayer(
  inner: ChannelPublisher,
  state: CueLayerState,
  opts: CueLayerOptions,
): ChannelPublisher {
  if (state.config.cueDelivery !== 'on') return installCueTee(inner, opts);
  return new DeliveryTee(inner, buildDeliveryEmitter(state, opts));
}

function buildDeliveryEmitter(state: CueLayerState, opts: CueLayerOptions): DeliveryEmitter {
  const platform = opts.platform ?? process.platform;
  const speakDeps: SpeakDeps = {
    platform,
    spawn: spawn as SpeakDeps['spawn'],
    voiceListenerRef: opts.voiceListenerRef,
    coachLine: opts.coachLine ?? null,
  };
  const liveOf = (context: SetContext): SetLookupLive | undefined =>
    state.slots.get(context.slot)?.live;
  return new DeliveryEmitter({
    speak: (request, source) => speak(request, speakDeps, source),
    platform,
    clock: Date.now,
    settings: opts.settings,
    selector: new CueSelector(),
    tierFor: (context) => tierFor(state, liveOf(context), context.setId),
    exerciseFor: (context) => withLive(liveOf(context), null, (l) => exerciseOf(l, context.setId)),
    repsFor: (context) => withLive(liveOf(context), [], (l) => repsOf(l, context.setId)),
    signalsFor: (context) => withLive(liveOf(context), {}, (l) => signalsOf(l, context.setId)),
  });
}

/** Owner question 2, default: the tier signal as-is, for whoever the set was snapshotted with. */
async function tierFor(
  state: CueLayerState,
  live: SetLookupLive | undefined,
  setId: string,
): Promise<Tier> {
  const lifter = live === undefined ? undefined : lifterOf(live, setId);
  return (await getTierSignal(state, lifter ?? LOCAL_USER_ID)).tier;
}

function withLive<T>(
  live: SetLookupLive | undefined,
  fallback: T,
  read: (live: SetLookupLive) => T,
): T {
  return live === undefined ? fallback : read(live);
}
