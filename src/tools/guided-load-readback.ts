// Read the device back after a guided-load write (VMCP-02.88, VMCP-02.89).
//
// `device.start_guided_load`, `device.exit_guided_load` and `device.unload`
// used to return a bare `{ ok: true }`, so "ok" meant only "the write did not
// throw". On a machine that applies physical load to a person that is a
// dangerous thing to call success. The fix is NOT to invent a confirmation: a
// wrong read-back is worse than none, because it turns an honest unknown into
// a confident false statement. So each tool now reports what was OBSERVED
// after the write, and says plainly when nothing observed it.
//
// How much each tool can actually observe differs, and the difference is a
// property of the SDK, not a choice made here:
//
//   * `start_guided_load` — the SDK's status poll is running while the flow
//     is live, and three phases (`countdown`, `engaging`, `active`) are
//     reachable ONLY by decoding a device status response. Reaching one of
//     them is therefore a device-sourced confirmation. `armed` is not: the
//     SDK synthesises `armed` locally the instant the trigger is written AND
//     derives it from a status response, so the value cannot tell the two
//     apart. Treating `armed` as confirmation would be the fabrication.
//   * `exit_guided_load` — the SDK stops the status poll BEFORE writing the
//     exit, so nothing reads the device afterwards at all. The phase reaching
//     `exited` is this server's own bookkeeping and is reported as such.
//   * `unload` — one fire-and-forget write with no echo, and `deriveLoadState`
//     reads `unloaded` during ordinary weight reps too, so it cannot tell a
//     released cable from a cable that is merely slack between reps. Nothing
//     available here can confirm the cable dropped.
//
// What all three CAN do is refuse to call an observed contradiction a success.
// That is what the mismatch errors below are for, and it is the half of
// VMCP-02.88 that is verifiable without a device.

import { MODE_REVERT_WINDOW_MS } from '../state/mode-revert-guard.js';
import { MODE_ECHO_POLL_MS } from './device-handler-helpers.js';
import { GUIDED_LOAD_ACTIVE_PHASES } from './device-exit.js';

/** Where an observed value came from. Never claim `device` for local state. */
export type ReadBackSource = 'device' | 'server';

/** What a post-write read established about the write. */
export interface GuidedLoadReadBack {
  verdict: 'confirmed' | 'unconfirmed';
  source: ReadBackSource;
  observed_phase: string;
  /** Why the read could not confirm. Present exactly when unconfirmed. */
  unconfirmed_reason?: string;
  waited_ms?: number;
  /** The device reported engagement with no countdown/engaging seen first. */
  ceremony_skipped?: true;
}

/** {@link GuidedLoadReadBack} plus the cable summary `device.unload` reads. */
export interface UnloadReadBack extends GuidedLoadReadBack {
  observed_load_state: 'loaded' | 'unloaded';
}

/**
 * Guided-load phases reachable only by decoding a device status response.
 *
 * `idle`, `exited` and `timeout` are synthesised by the SDK with no device
 * involvement. `armed` is reachable both ways and so proves nothing — see the
 * module comment.
 */
export const DEVICE_REPORTED_PHASES: ReadonlySet<string> = new Set([
  'countdown',
  'engaging',
  'active',
]);

/**
 * Bound on the post-trigger wait for the device to report a phase.
 *
 * This is `MODE_REVERT_WINDOW_MS` reused rather than a window of its own: at
 * the SDK's 500ms status cadence it gives the device three or four chances to
 * answer, and a read held open past the point the mode-revert guard stops
 * evaluating divergence would outlast the safety machinery backing it.
 *
 * It bounds "did the device answer", NOT "did the load engage". Engagement is
 * gated on a person pulling the cable and has no citable window — the SDK's
 * 18s poll duration is the ceremony's budget, not a confirmation deadline, and
 * no measurement of the real figure exists. That one is a bench measurement.
 */
export const GUIDED_LOAD_READ_BACK_WINDOW_MS = MODE_REVERT_WINDOW_MS;

const TRIGGER_UNCONFIRMED_REASON =
  "The flow is armed in this server's own state machine; no device status " +
  'response arrived inside the read-back window. `armed` is reported ' +
  'identically whether the device answered or the SDK synthesised it on the ' +
  'trigger write, so it cannot confirm anything. Engagement is confirmed ' +
  'later by the `guided_load_state` channel event (outcome `engaged`), or ' +
  'refuted by it (outcome `failed`).';

const EXIT_UNCONFIRMED_REASON =
  'The exit was written and this server moved its own phase off the active ' +
  'set, but nothing read the device back: the SDK stops the status poll ' +
  'before it writes the exit, so no device-sourced observation of the exit ' +
  'exists. Exit also does not release residual cable tension — call ' +
  'device.unload for that.';

const UNLOAD_UNCONFIRMED_REASON =
  'The unload was written, but the device acknowledges it with nothing this ' +
  'server can read, and `load_state` reads `unloaded` during ordinary weight ' +
  'reps too — so it cannot tell a released cable from a slack one. Treat the ' +
  'cable as unverified and confirm by eye before loading a lifter.';

export interface ReadBackWaitOptions {
  timeoutMs?: number | undefined;
  pollMs?: number | undefined;
}

function readBackError(code: string, message: string): never {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  throw err;
}

function triggerContradiction(slotId: string, phase: string, targetWeightLbs: number): never {
  readBackError(
    'GUIDED_LOAD_NOT_ARMED',
    `Slot \`${slotId}\` reports guided-load phase "${phase}" after the ` +
      `${targetWeightLbs} lb trigger was written, so the flow is not running. ` +
      'Whether the cable is holding load is unknown from here — call device.unload, ' +
      'then re-issue device.start_guided_load.',
  );
}

/**
 * Wait for the device to report a guided-load phase after the trigger.
 *
 * Resolves early on the first device-reported phase, fails on an observed
 * contradiction, and otherwise reports the honest unknown at the deadline —
 * it never reports success for an unobserved write, and it never waits past
 * the bound. `checkFence` runs before every read so a lease steal mid-wait
 * aborts with `LEASE_LOST` rather than being reported as a guided-load result.
 */
export async function readBackGuidedLoadTrigger(
  ctx: { slotId: string; targetWeightLbs: number; readPhase: () => string; checkFence: () => void },
  options: ReadBackWaitOptions = {},
): Promise<GuidedLoadReadBack> {
  const timeoutMs = options.timeoutMs ?? GUIDED_LOAD_READ_BACK_WINDOW_MS;
  const pollMs = options.pollMs ?? MODE_ECHO_POLL_MS;
  const startedAt = Date.now();
  let sawCeremony = false;
  for (;;) {
    ctx.checkFence();
    const phase = ctx.readPhase();
    if (phase === 'countdown' || phase === 'engaging') sawCeremony = true;
    if (DEVICE_REPORTED_PHASES.has(phase)) {
      const observed: GuidedLoadReadBack = {
        verdict: 'confirmed',
        source: 'device',
        observed_phase: phase,
        waited_ms: Date.now() - startedAt,
      };
      if (phase === 'active' && !sawCeremony) observed.ceremony_skipped = true;
      return observed;
    }
    if (!GUIDED_LOAD_ACTIVE_PHASES.has(phase)) {
      triggerContradiction(ctx.slotId, phase, ctx.targetWeightLbs);
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      return {
        verdict: 'unconfirmed',
        source: 'server',
        observed_phase: phase,
        waited_ms: elapsed,
        unconfirmed_reason: TRIGGER_UNCONFIRMED_REASON,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, timeoutMs - elapsed)));
  }
}

/**
 * Read back `device.exit_guided_load`. A phase still inside the active set is
 * an observed contradiction and fails the call; anything else is reported as
 * the unconfirmed server-side observation it is.
 */
export function readBackGuidedLoadExit(slotId: string, phase: string): GuidedLoadReadBack {
  if (GUIDED_LOAD_ACTIVE_PHASES.has(phase)) {
    readBackError(
      'GUIDED_LOAD_EXIT_UNCONFIRMED',
      `Slot \`${slotId}\` still reports guided-load phase "${phase}" after the exit ` +
        'was written, so the flow did not end. The device may still be holding ' +
        'load — call device.unload.',
    );
  }
  return {
    verdict: 'unconfirmed',
    source: 'server',
    observed_phase: phase,
    unconfirmed_reason: EXIT_UNCONFIRMED_REASON,
  };
}

/**
 * Read back `device.unload`. When the unload tore down a live guided-load
 * flow, a phase still inside the active set is an observed contradiction and
 * fails the call. The cable itself is never confirmable — see the module
 * comment — so the verdict is `unconfirmed` on every success.
 */
export function readBackUnload(ctx: {
  slotId: string;
  phase: string;
  loadState: 'loaded' | 'unloaded';
  guidedLoadWasActive: boolean;
}): UnloadReadBack {
  if (ctx.guidedLoadWasActive && GUIDED_LOAD_ACTIVE_PHASES.has(ctx.phase)) {
    readBackError(
      'UNLOAD_UNCONFIRMED',
      `Slot \`${ctx.slotId}\` still reports guided-load phase "${ctx.phase}" after the ` +
        'unload was written, so the flow it was meant to tear down is still running ' +
        'and the cable may still be holding load. Call device.exit_guided_load, then ' +
        'device.unload again.',
    );
  }
  return {
    verdict: 'unconfirmed',
    source: 'server',
    observed_phase: ctx.phase,
    observed_load_state: ctx.loadState,
    unconfirmed_reason: UNLOAD_UNCONFIRMED_REASON,
  };
}
