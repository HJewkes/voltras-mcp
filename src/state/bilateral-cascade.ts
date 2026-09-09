// Helper for the `bilateral.cascade` tool — fans 1-4 device setters across
// 1-N slots concurrently and reports per-slot, per-setter outcomes.
//
// Why a separate module: the device-tools.ts handler is already 800+ lines of
// SDK glue. The cascade logic (parallel-within-slot, parallel-across-slots,
// abort-on-first-failure semantics) is dense enough that inlining it would
// push the handler over the 80-line ceiling; a focused helper keeps the
// device-tools registration table readable.
//
// Concurrency model:
//   * VW-162 — the MODE write is never part of the fan-out. When the plan
//     changes the slot's mode, the mode setter goes first on its own, the
//     slot's mode-revert guard is armed for it (exactly as `device.set_mode`
//     does), and we wait for the device's cmd=0x10 echo before any other
//     setter fires. This header used to claim there was "no documented
//     ordering dependency" between the four setters; hardware falsified that
//     on 2026-09-07 — a `{mode: Isokinetic, ...}` cascade left the right unit
//     in WeightTraining and the left in Idle within ~1s, twice, while
//     `device.set_mode` alone stuck. The weight/eccentric/chains writes
//     racing the mode write make the firmware fall back. When the mode is
//     already the live one, there is nothing to wait for and the wait is
//     skipped. Slots still run concurrently with each other.
//   * `abortOnFirstFailure: false` (default) — within a slot, the remaining
//     setters fire concurrently via `Promise.all`. Across slots, each slot's
//     local fan-out runs in its own `Promise.all` so a thrown setter on slot
//     A never prevents slot B from being attempted (per-setter rejection is
//     captured into the result before the outer `Promise.all` sees it).
//   * `abortOnFirstFailure: true` — setters within a slot run SEQUENTIALLY
//     (so the next setter can observe the previous one's failure and skip),
//     and the slot fan-out across slots still happens concurrently but each
//     slot's sequential pipeline checks a shared abort flag before each
//     write. The first setter to reject anywhere flips the flag; every
//     subsequent setter (in the same slot or in another slot's pipeline)
//     short-circuits without firing. Setters that were never attempted are
//     absent from the `applied` map — including every setter behind a mode
//     write whose echo timed out, in either branch.
//   * VMCP-01.65 — an optional write-lease fence is re-checked before every
//     setter and again after the mode-echo wait. A force-steal that lands
//     during the wait aborts the whole cascade with LEASE_LOST, and no slot
//     issues a setter it had not already started.
//
// The helper does NOT validate slots — the caller is expected to verify each
// slot id is bound BEFORE entering this function (so unbound-slot errors
// surface as INVALID_INPUT before any BLE write fires, not as a per-slot
// failure mixed in with real setter outcomes).

import type { TrainingMode, VoltraClient } from '@voltras/node-sdk';

import { waitForModeEcho } from '../tools/device-handler-helpers.js';
import type { CoercionWatch } from './coercion-watch.js';
import type { LeaseFence } from './lease-fence.js';
import { MODE_REVERT_WINDOW_MS, type ModeRevertGuard } from './mode-revert-guard.js';

/** Outcome of the VW-162 pre-fan-out wait for the device's mode echo. */
export type ModeEchoStatus = 'confirmed' | 'timeout' | 'skipped';

/** Tunable bounds for the mode-echo wait. Defaults are the production values. */
export interface CascadeOptions {
  /**
   * Bound on the wait for the device to echo the requested mode. Defaults to
   * `MODE_REVERT_WINDOW_MS`: past that the mode-revert guard has stopped
   * evaluating divergence for this write, so a longer wait would report a
   * confirmation the safety guard no longer stands behind.
   */
  modeEchoTimeoutMs?: number;
  modeEchoPollMs?: number;
  /**
   * VMCP-01.65: the write-lease fence, re-checked before every setter and
   * again after the mode-echo wait. When another client takes the device
   * mid-cascade, the setters that have not fired yet never do — including
   * every setter on a slot whose own pipeline had not started. Optional for
   * the same forward-compatibility reason as `coercionWatch`: without one the
   * cascade behaves exactly as it did before.
   */
  fence?: LeaseFence;
}

/**
 * Per-setter outcome shape. `value` echoes the requested value back so the
 * caller has a single payload to read for both success ("here is what was
 * applied") and failure ("here is what we tried to apply, and why it
 * failed"). The SDK setters all return `Promise<void>`, so `value` is always
 * the requested input — never an SDK-returned echo.
 */
export interface SetterOutcome {
  ok: boolean;
  error?: string;
  value?: number | string;
}

/**
 * Per-slot result. `applied` carries one entry per setter that was REQUESTED
 * (not per setter that exists). A request with `weightLbs` only produces an
 * `applied` map with a single `weightLbs` key — `mode`/`eccentric`/`chains`
 * stay absent.
 */
export interface SlotResult {
  slot: string;
  applied: {
    mode?: SetterOutcome;
    weightLbs?: SetterOutcome;
    eccentricPercent?: SetterOutcome;
    chainsLbs?: SetterOutcome;
  };
  /**
   * VW-162: how the pre-fan-out mode wait resolved. `skipped` covers both
   * "no mode requested" and "the device already sits in that mode", so it is
   * only meaningful alongside `applied.mode`. Absent when the slot has no
   * mode-revert guard to observe the echo through (test fixtures).
   */
  modeEcho?: ModeEchoStatus;
  /** Milliseconds between the mode write resolving and the echo landing. */
  echoedAfterMs?: number;
}

/**
 * Plan of setter values to apply. Each field is OPTIONAL — only the
 * provided fields fire. `mode` is the numeric SDK enum value (the caller
 * has already mapped from the string enum name). `eccentricPercent` is the
 * raw SDK percent (-195..195) — the field is named for the unit, not for a
 * pounds-conversion (the SDK's `setEccentric(percent)` takes percent).
 */
export interface CascadePlan {
  mode?: TrainingMode;
  weightLbs?: number;
  eccentricPercent?: number;
  chainsLbs?: number;
}

export interface SlotTarget {
  slotId: string;
  client: Pick<VoltraClient, 'setMode' | 'setWeight' | 'setEccentric' | 'setChains'>;
  /**
   * Per-slot coercion ledger threaded in so successful setters register a
   * pending F2/F3 check. Optional so existing test fixtures + non-coercion-
   * aware callers stay forward-compatible — when absent, setter success is
   * a silent passthrough on the coercion path.
   */
  coercionWatch?: CoercionWatch;
  /**
   * VW-162: the slot's mode-revert guard, armed for the requested mode and
   * then read for the device's echo before the other setters fan out.
   * Optional for the same forward-compatibility reason as `coercionWatch` —
   * without it there is no echo to observe, so the mode write still goes
   * first but nothing waits on it.
   */
  modeRevertGuard?: Pick<ModeRevertGuard, 'arm' | 'echoedMode'>;
}

/**
 * Cascade `plan` across every slot in `targets`. Slots are processed in
 * input order; within each slot the requested setters fan out concurrently.
 * Returns `SlotResult[]` in the SAME order as `targets`.
 *
 * `abortOnFirstFailure`: once any setter on any slot rejects, no further
 * setters are SCHEDULED. Setters already in flight on the same tick still
 * resolve (we cannot cancel an in-flight `Promise`), and their results are
 * recorded into the `applied` map. This keeps the abort semantics
 * predictable without claiming we can un-write a BLE frame that has already
 * left the adapter.
 */
export async function cascadeAcrossSlots(
  targets: SlotTarget[],
  plan: CascadePlan,
  abortOnFirstFailure: boolean,
  options: CascadeOptions = {},
): Promise<SlotResult[]> {
  // Shared abort flag — flipped by the first failing setter when
  // `abortOnFirstFailure` is true. Callbacks check it BEFORE invoking the
  // SDK so an early failure on slot A short-circuits not-yet-started
  // setters on slot A and on slot B.
  const abortFlag = { aborted: false };

  const slotPromises = targets.map((target) =>
    runSlotPlan(target, plan, abortFlag, abortOnFirstFailure, options),
  );
  const results = await Promise.all(slotPromises);
  return results;
}

interface AbortFlag {
  aborted: boolean;
}

/**
 * Typed step descriptor. Keeping the setters as data lets us run the
 * sequential and concurrent paths without duplicating the branch ladder.
 * Each step also carries an optional `coercionField` + `coercionRequested`
 * pair so a successful setter registers a pending F2/F3 coercion check
 * against the slot's watch. The `mode` setter has no coercion correlation
 * today (the device's training-mode echo doesn't route through
 * CoercionWatch) — VW-162 gates on it directly instead.
 */
interface CascadeStep {
  key: keyof SlotResult['applied'];
  invoke: () => Promise<void>;
  value: number | string;
  coercionField?: string;
  coercionRequested?: number;
}

async function runSlotPlan(
  target: SlotTarget,
  plan: CascadePlan,
  abortFlag: AbortFlag,
  abortOnFirstFailure: boolean,
  options: CascadeOptions,
): Promise<SlotResult> {
  const applied: SlotResult['applied'] = {};
  const result: SlotResult = { slot: target.slotId, applied };

  // VMCP-01.65: nothing may be written on this slot if the device already
  // changed hands. The lease guard checked at call entry; a two-slot cascade
  // can still reach here after a steal landed while another slot awaited.
  options.fence?.check(target.slotId);

  // VW-162: the mode write runs alone and its echo is waited for before
  // anything else touches the slot, so the other setters cannot race it into
  // a firmware fallback.
  if (plan.mode !== undefined) {
    const gate = await runModeStep(target, plan.mode, abortFlag, abortOnFirstFailure, options);
    applied.mode = gate.outcome;
    result.modeEcho = gate.echo;
    if (gate.echoedAfterMs !== undefined) result.echoedAfterMs = gate.echoedAfterMs;
    if (!gate.proceed) return result;
  }
  // The echo wait above is the longest await in the cascade and the one a
  // force-steal most often lands inside. Re-check before the fan-out.
  options.fence?.check(target.slotId);

  await runFanOut(target, buildFanOutSteps(target, plan), applied, {
    abortFlag,
    abortOnFirstFailure,
    options,
  });
  return result;
}

/**
 * Run the weight/eccentric/chains steps for one slot, sequentially under
 * `abortOnFirstFailure` and concurrently otherwise, recording each outcome
 * into `applied`.
 *
 * The fence check sits OUTSIDE `runSetter` on purpose: a lost lease must fail
 * the whole tool with LEASE_LOST, not read as one setter that happened to
 * reject.
 */
async function runFanOut(
  target: SlotTarget,
  steps: CascadeStep[],
  applied: SlotResult['applied'],
  ctx: { abortFlag: AbortFlag; abortOnFirstFailure: boolean; options: CascadeOptions },
): Promise<void> {
  const { abortFlag, abortOnFirstFailure, options } = ctx;
  const record = (step: CascadeStep, outcome: SetterOutcome): void => {
    applied[step.key] = outcome;
    maybeRegisterCoercion(target.coercionWatch, step, outcome);
  };
  if (abortOnFirstFailure) {
    // Sequential within a slot so the next setter can observe the prior
    // one's failure and skip — concurrency would defeat the abort
    // semantic since every setter would already be in-flight by the
    // time the first rejection settles.
    for (const step of steps) {
      if (abortFlag.aborted) break;
      options.fence?.check(target.slotId);
      record(step, await runSetter(step.invoke, step.value, true, abortFlag));
    }
    return;
  }
  // Concurrent within a slot — `runSetter` converts rejections into
  // SetterOutcome records, so the wrapping `Promise.all` cannot itself reject.
  await Promise.all(
    steps.map(async (step) => {
      options.fence?.check(target.slotId);
      record(step, await runSetter(step.invoke, step.value, false, abortFlag));
    }),
  );
}

/** The weight/eccentric/chains steps — everything that fans out after mode. */
function buildFanOutSteps(target: SlotTarget, plan: CascadePlan): CascadeStep[] {
  const steps: CascadeStep[] = [];
  if (plan.weightLbs !== undefined) {
    const weightValue = plan.weightLbs;
    steps.push({
      key: 'weightLbs',
      invoke: () => target.client.setWeight(weightValue),
      value: weightValue,
      // VMCP-02.40: coercion source switched from state-dump
      // `weightLbsTenths` (×10, lazy) to cmd=0x10 `baseWeight` (whole lbs).
      coercionField: 'baseWeight',
      coercionRequested: weightValue,
    });
  }
  if (plan.eccentricPercent !== undefined) {
    const eccValue = plan.eccentricPercent;
    steps.push({
      key: 'eccentricPercent',
      invoke: () => target.client.setEccentric(eccValue),
      value: eccValue,
      // Eccentric stays on the state-dump path for now — has a documented
      // 80→320→0 transient burst that the 2-of-2 stability counter
      // defuses. A separate pass may route this through cmd=0x10.
      coercionField: 'eccentricPercentTenths',
      coercionRequested: eccValue * 10,
    });
  }
  if (plan.chainsLbs !== undefined) {
    const chainsValue = plan.chainsLbs;
    steps.push({
      key: 'chainsLbs',
      invoke: () => target.client.setChains(chainsValue),
      value: chainsValue,
      // VMCP-02.40: coercion source switched from state-dump
      // `chainTargetForceTenths` (×10, lazy) to cmd=0x10 `chains` (whole lbs).
      coercionField: 'chains',
      coercionRequested: chainsValue,
    });
  }
  return steps;
}

/** Outcome of the mode write plus its echo wait. */
interface ModeGate {
  outcome: SetterOutcome;
  echo: ModeEchoStatus;
  echoedAfterMs?: number;
  /** False when the slot's remaining setters must NOT be issued. */
  proceed: boolean;
}

/**
 * VW-162: write the mode, arm the slot's mode-revert guard for it, and hold
 * the rest of the slot's cascade until the device echoes it back.
 *
 * A timeout fails the slot rather than proceeding: the whole point of the
 * ordering is that weight/eccentric/chains must not be written against an
 * unconfirmed mode. A rejected mode write is different — the mode never
 * changed, so there is no race, and the pre-existing `abortOnFirstFailure`
 * semantics decide whether the rest still fires.
 */
async function runModeStep(
  target: SlotTarget,
  mode: TrainingMode,
  abortFlag: AbortFlag,
  abortOnFirstFailure: boolean,
  options: CascadeOptions,
): Promise<ModeGate> {
  const guard = target.modeRevertGuard;
  const alreadyLive = guard !== undefined && guard.echoedMode() === mode;
  const outcome = await runSetter(
    () => target.client.setMode(mode),
    mode,
    abortOnFirstFailure,
    abortFlag,
  );
  if (!outcome.ok) return { outcome, echo: 'skipped', proceed: !abortOnFirstFailure };
  // Arm even when the mode is unchanged: it is the same user request
  // `device.set_mode` makes, and arming for a mode the device already echoes
  // is what clears a stale revert latch (VW-163).
  guard?.arm(mode);
  if (guard === undefined || alreadyLive) return { outcome, echo: 'skipped', proceed: true };

  const echoedAfterMs = await waitForModeEcho(guard, mode, {
    timeoutMs: options.modeEchoTimeoutMs,
    pollMs: options.modeEchoPollMs,
  });
  if (echoedAfterMs === null) {
    if (abortOnFirstFailure) abortFlag.aborted = true;
    return {
      outcome: { ok: false, value: mode, error: modeEchoTimeoutMessage(options) },
      echo: 'timeout',
      proceed: false,
    };
  }
  return { outcome, echo: 'confirmed', echoedAfterMs, proceed: true };
}

function modeEchoTimeoutMessage(options: CascadeOptions): string {
  const timeoutMs = options.modeEchoTimeoutMs ?? MODE_REVERT_WINDOW_MS;
  return (
    `The device did not echo the requested training mode within ${timeoutMs}ms, ` +
    `so the remaining setters on this slot were not issued (they would have raced ` +
    `the unconfirmed mode write). Re-issue device.set_mode for this slot and check ` +
    `device.get_state before retrying the cascade.`
  );
}

/**
 * Register a pending F2/F3 coercion check when the setter succeeded and
 * the step carried a coercion-field mapping. Failed setters never register
 * a check (the device didn't receive the write); steps without a
 * `coercionField` (today: `setMode`) are skipped.
 */
function maybeRegisterCoercion(
  watch: CoercionWatch | undefined,
  step: {
    coercionField?: string;
    coercionRequested?: number;
  },
  outcome: SetterOutcome,
): void {
  if (
    watch === undefined ||
    !outcome.ok ||
    step.coercionField === undefined ||
    step.coercionRequested === undefined
  ) {
    return;
  }
  watch.register({
    setterName: 'bilateral.cascade',
    field: step.coercionField,
    requested: step.coercionRequested,
    setterReturnedAt: Date.now(),
  });
}

/**
 * Invoke a single SDK setter and convert its outcome into a `SetterOutcome`.
 * When `abortOnFirstFailure` is true and the call rejects, flips the shared
 * abort flag so subsequent setters on this slot AND on other slots'
 * sequential pipelines short-circuit before they fire.
 */
async function runSetter<TValue extends number | string>(
  invoke: () => Promise<void>,
  value: TValue,
  abortOnFirstFailure: boolean,
  abortFlag: AbortFlag,
): Promise<SetterOutcome> {
  try {
    await invoke();
    return { ok: true, value };
  } catch (err) {
    if (abortOnFirstFailure) {
      abortFlag.aborted = true;
    }
    return { ok: false, error: errorMessage(err), value };
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
