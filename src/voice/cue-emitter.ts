// Deterministic outbound cue emitter (VMCP-02.79, PR4).
//
// Tees off the channel-event stream and speaks templated coaching cues the
// instant a cue-worthy event fires — no LLM round-trip, so cues land on time
// instead of arriving stale (the VMCP-02.58 "rep 5 after the set ended" bug).
//
// Layering: `decideCue` (pure policy) classifies the event, `CueSelector` +
// `slotFill` (pure templates) render the line, and the shared `speak()` from
// tts-tools plays it — the SAME path `system.speak` uses, so cues duck the STT
// mic and share interrupt/in-flight tracking with LLM speech.

import { spawn } from 'node:child_process';

import type { ChannelEvent, ChannelPublisher } from '../state/channel-publisher.js';
import { speak, type SpeakDeps, type VoiceListenerRef } from '../tools/tts-tools.js';
import { decideCue } from './cue-policy.js';
import { CueSelector, slotFill } from './cue-templates.js';

export interface CueEmitterDeps {
  /** How/where to play cues. `platform` gates the emitter (say is macOS-only). */
  speakDeps: SpeakDeps;
  /** Injectable for tests; defaults to the shared tts-tools `speak`. */
  speak?: typeof speak;
  /** Injectable for deterministic tests; defaults to a fresh selector. */
  selector?: CueSelector;
}

/**
 * Turns cue-worthy channel events into spoken cues. Fire-and-forget: a cue
 * never blocks and its failure is swallowed by the tee, so channel delivery is
 * never affected. Speaks each category at most once per set. macOS-only — a
 * no-op on any other platform.
 */
export class CueEmitter {
  private readonly speakDeps: SpeakDeps;
  private readonly speakFn: typeof speak;
  private readonly selector: CueSelector;
  /** `${category}:${setId}` keys already spoken, so a category fires once/set. */
  private readonly fired = new Set<string>();

  constructor(deps: CueEmitterDeps) {
    this.speakDeps = deps.speakDeps;
    this.speakFn = deps.speak ?? speak;
    this.selector = deps.selector ?? new CueSelector();
  }

  onEvent(event: ChannelEvent): void {
    if (this.speakDeps.platform !== 'darwin') return;
    const decision = decideCue(event);
    if (decision === null) return;
    const key = `${decision.category}:${decision.setId}`;
    if (this.fired.has(key)) return;
    this.fired.add(key);
    const template = this.selector.pick(decision.category, Object.keys(decision.slots));
    void this.speakFn(
      {
        text: slotFill(template, decision.slots),
        interrupt: decision.priority === 'urgent',
        blocking: false,
      },
      this.speakDeps,
    ).catch(() => {
      // Best-effort: a failed cue must not surface as an unhandled rejection.
    });
  }
}

/**
 * Channel publisher decorator that forwards every event to `inner` unchanged,
 * then feeds it to the cue emitter. The passthrough is byte-identical to the
 * undecorated publisher; a cue failure is caught here so it can never disrupt
 * channel delivery.
 */
export class CueTeePublisher implements ChannelPublisher {
  constructor(
    private readonly inner: ChannelPublisher,
    private readonly emitter: CueEmitter,
  ) {}

  publish(event: ChannelEvent): void {
    this.inner.publish(event);
    try {
      this.emitter.onEvent(event);
    } catch {
      // Cues are best-effort — never let one break channel delivery.
    }
  }

  forSlot(slotId: string): ChannelPublisher {
    // Slot-scoped sends still tee: wrap the slot-scoped inner with the SAME
    // emitter so per-slot events produce cues and share the fire-once dedup.
    return new CueTeePublisher(this.inner.forSlot(slotId), this.emitter);
  }
}

/**
 * Wrap `inner` with a cue-emitting tee when cues are enabled, else return it
 * unchanged. Builds the emitter's speak deps from the live process + the same
 * voice-listener ref `system.speak` uses (so cues duck the mic).
 */
export function maybeCueTee(
  inner: ChannelPublisher,
  opts: { enabled: boolean; voiceListenerRef: VoiceListenerRef | null },
): ChannelPublisher {
  if (!opts.enabled) return inner;
  const speakDeps: SpeakDeps = {
    platform: process.platform,
    spawn: spawn as SpeakDeps['spawn'],
    voiceListenerRef: opts.voiceListenerRef,
  };
  return new CueTeePublisher(inner, new CueEmitter({ speakDeps }));
}
