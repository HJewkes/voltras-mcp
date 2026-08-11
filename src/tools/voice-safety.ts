// The `VoiceSafetyContext` the Tier-A voice fast-path drives (VMCP-02.78).
//
// Lives in its own module so the wiring between `ServerState` and the voice
// listener is directly testable: VMCP-02.86 was a slot-resolution bug that no
// test could reach while this was a private closure inside client-connection.

import { spawn } from 'node:child_process';

import type { ServerState } from '../state/server-state.js';
import { isSafetyUnloadWarranted, unloadSlot } from './device-tools.js';
import { speak, type SpeakDeps } from './tts-tools.js';
import type { VoiceSafetyContext } from './voice-tools.js';

/**
 * Build the safety hooks over live server state. The voice listener calls into
 * these when it hears a stop phrase, unloading the cable directly with no LLM
 * round-trip. Shares the state's voice-listener ref so the "stopping" ack ducks
 * the mic.
 *
 * `connectedSlots` is what makes the path slot-agnostic: it reports whatever is
 * actually bound (`primary`, or `left`/`right` on a bilateral rig) instead of
 * assuming a slot name that may not exist.
 */
export function makeVoiceSafety(state: ServerState): VoiceSafetyContext {
  return {
    connectedSlots: () =>
      [...state.slots.values()]
        .filter((slot) => slot.client.isConnected)
        .map((slot) => slot.slotId),
    evaluate: (slotId) => {
      const verdict = isSafetyUnloadWarranted(state, slotId);
      const setId = state.slots.get(slotId)?.live.snapshotSet()?.setId ?? null;
      return { warranted: verdict.warranted, reason: verdict.reason, setId };
    },
    unload: (slotId) => unloadSlot(state, slotId),
    speakAck: (text) => {
      const deps: SpeakDeps = {
        platform: process.platform,
        spawn: spawn as SpeakDeps['spawn'],
        voiceListenerRef: state.voice,
      };
      void speak({ text, interrupt: true, blocking: false }, deps).catch(() => {
        // Best-effort ack — never let a failed cue affect the unload.
      });
    },
  };
}
