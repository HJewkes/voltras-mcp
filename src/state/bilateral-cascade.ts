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
//   * `abortOnFirstFailure: false` (default) — within a slot, the requested
//     setters fire concurrently via `Promise.all`. None of the four cover
//     the same SDK opcode and there's no documented ordering dependency
//     between them. Across slots, each slot's local fan-out runs in its own
//     `Promise.all` so a thrown setter on slot A never prevents slot B from
//     being attempted (per-setter rejection is captured into the result
//     before the outer `Promise.all` sees it).
//   * `abortOnFirstFailure: true` — setters within a slot run SEQUENTIALLY
//     (so the next setter can observe the previous one's failure and skip),
//     and the slot fan-out across slots still happens concurrently but each
//     slot's sequential pipeline checks a shared abort flag before each
//     write. The first setter to reject anywhere flips the flag; every
//     subsequent setter (in the same slot or in another slot's pipeline)
//     short-circuits without firing. Setters that were never attempted are
//     absent from the `applied` map.
//
// The helper does NOT validate slots — the caller is expected to verify each
// slot id is bound BEFORE entering this function (so unbound-slot errors
// surface as INVALID_INPUT before any BLE write fires, not as a per-slot
// failure mixed in with real setter outcomes).

import type { TrainingMode, VoltraClient } from '@voltras/node-sdk';

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

interface SlotTarget {
  slotId: string;
  client: Pick<VoltraClient, 'setMode' | 'setWeight' | 'setEccentric' | 'setChains'>;
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
): Promise<SlotResult[]> {
  // Shared abort flag — flipped by the first failing setter when
  // `abortOnFirstFailure` is true. Callbacks check it BEFORE invoking the
  // SDK so an early failure on slot A short-circuits not-yet-started
  // setters on slot A and on slot B.
  const abortFlag = { aborted: false };

  const slotPromises = targets.map((target) =>
    runSlotPlan(target, plan, abortFlag, abortOnFirstFailure),
  );
  const results = await Promise.all(slotPromises);
  return results;
}

interface AbortFlag {
  aborted: boolean;
}

async function runSlotPlan(
  target: SlotTarget,
  plan: CascadePlan,
  abortFlag: AbortFlag,
  abortOnFirstFailure: boolean,
): Promise<SlotResult> {
  const applied: SlotResult['applied'] = {};

  // Build typed step descriptors. Keeping them as data lets us run the
  // sequential and concurrent paths without duplicating the branch ladder.
  const steps: Array<{
    key: keyof SlotResult['applied'];
    invoke: () => Promise<void>;
    value: number | string;
  }> = [];
  if (plan.mode !== undefined) {
    const modeValue = plan.mode;
    steps.push({
      key: 'mode',
      invoke: () => target.client.setMode(modeValue),
      value: modeValue,
    });
  }
  if (plan.weightLbs !== undefined) {
    const weightValue = plan.weightLbs;
    steps.push({
      key: 'weightLbs',
      invoke: () => target.client.setWeight(weightValue),
      value: weightValue,
    });
  }
  if (plan.eccentricPercent !== undefined) {
    const eccValue = plan.eccentricPercent;
    steps.push({
      key: 'eccentricPercent',
      invoke: () => target.client.setEccentric(eccValue),
      value: eccValue,
    });
  }
  if (plan.chainsLbs !== undefined) {
    const chainsValue = plan.chainsLbs;
    steps.push({
      key: 'chainsLbs',
      invoke: () => target.client.setChains(chainsValue),
      value: chainsValue,
    });
  }

  if (abortOnFirstFailure) {
    // Sequential within a slot so the next setter can observe the prior
    // one's failure and skip — concurrency would defeat the abort
    // semantic since every setter would already be in-flight by the
    // time the first rejection settles.
    for (const step of steps) {
      if (abortFlag.aborted) break;
      const outcome = await runSetter(step.invoke, step.value, true, abortFlag);
      applied[step.key] = outcome;
    }
  } else {
    // Concurrent within a slot — `runSetter` converts rejections into
    // SetterOutcome records, so the wrapping `Promise.all` cannot itself
    // reject.
    await Promise.all(
      steps.map(async (step) => {
        applied[step.key] = await runSetter(step.invoke, step.value, false, abortFlag);
      }),
    );
  }
  return { slot: target.slotId, applied };
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
