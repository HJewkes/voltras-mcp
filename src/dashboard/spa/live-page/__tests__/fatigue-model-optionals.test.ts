/**
 * MECHANICAL GUARD 2 of 2 for the SPA↔titan fatigue contract (VMCP-03.06): titan's OPTIONAL
 * fields, spelled out one by one.
 *
 * The failure this exists for. `plannedReps` shipped in titan 0.12.0 to drive
 * `RomProgressionChart`'s dashed to-do slots; the SPA's hand-mirrored model and its mapper
 * had zero occurrences of it. Lint clean, tsc clean on both configs, suite green — and every
 * set silently rendered as complete. Nothing type-checks a prop allowed to be absent, so a
 * required-field drift is loud and an optional-field drift is invisible.
 *
 * Two halves, and they catch opposite directions:
 *   - {@link everyTitanOptional} — an object literal spelling every optional titan declares.
 *     Excess-property checking fails it the moment titan REMOVES or RENAMES one.
 *   - `TitanOptionalKeys` vs `AccountedFor` — a type-level set equality. It fails the moment
 *     titan ADDS an optional this file has not been updated for, which is the exact shape of
 *     the `plannedReps` miss. Importing titan's type alone cannot catch that: the new field
 *     just arrives, unset by the mapper, rendering as a gap nobody asked for.
 *
 * On a titan bump: read the tsc error, add the field here, then wire it in the mapper.
 */
import { describe, expect, it } from 'vitest';
import type { LiveFatigueModel as TitanLiveFatigueModel } from '@titan-design/react-ui';

import type { LiveFatigueModel } from '../fatigue-model';

/** The optional property names titan's `LiveFatigueModel` currently declares. */
type TitanOptionalKeys = {
  [K in keyof TitanLiveFatigueModel]-?: undefined extends TitanLiveFatigueModel[K] ? K : never;
}[keyof TitanLiveFatigueModel];

/** The optionals this repo has read and wired. Keep in step with titan, one name per bump. */
type AccountedFor = 'plannedReps';

/** Compiles to `true` only when `A` is assignable to `B`; otherwise tsc names the offender. */
type AssertAssignable<A extends B, B> = A extends B ? true : never;

/**
 * THE ADD-DIRECTION GUARD. A new optional on titan's model widens `TitanOptionalKeys`,
 * `npm run typecheck` fails, and the error names the new field — the signal that was missing
 * when `plannedReps` arrived. Deleting these two lines restores the silent drift.
 */
type EveryTitanOptionalIsListed = AssertAssignable<TitanOptionalKeys, AccountedFor>;
/** The reverse: a name this file still lists after titan dropped it. */
type EveryListedOptionalIsTitans = AssertAssignable<AccountedFor, TitanOptionalKeys>;

const ACCOUNTED_FOR: [EveryTitanOptionalIsListed, EveryListedOptionalIsTitans] = [true, true];

/**
 * THE REMOVE-DIRECTION GUARD. Every optional above, present on a fresh object literal typed
 * `LiveFatigueModel`. Drop `plannedReps` from titan's type and tsc rejects this literal:
 * "Object literal may only specify known properties, and 'plannedReps' does not exist in
 * type 'LiveFatigueModel & {...}'".
 */
const everyTitanOptional: LiveFatigueModel = {
  rpe: 7.5,
  repsInReserve: 2.5,
  verdict: {
    state: 'slowing',
    tone: 'warn',
    dimensions: { velocityLoss: 'warn', rom: 'ok', tempo: 'ok' },
  },
  romProgression: [
    { repNumber: 1, romM: 0.4 },
    { repNumber: 2, romM: 0.38 },
  ],
  // ── titan optionals ────────────────────────────────────────────────────────
  plannedReps: 8,
  // ───────────────────────────────────────────────────────────────────────────
  romWorkingStandardM: 0.4,
  romShortThresholdM: 0.3,
  velocityCurves: [
    {
      repNumber: 1,
      samples: [{ tMs: 0, velocityMps: 0.5, phase: 'concentric' }],
      phaseSegments: [{ phase: 'concentric', startMs: 0, endMs: 500 }],
      tempoDeviation: 0.1,
      grindSignature: 0.2,
    },
  ],
  tempoSeconds: [2, 0, 1, 0],
  targetTempoSeconds: [3, 0, 1, 0],
  contributingLimbCount: 2,
  asymmetry: { pct: 8, strongerSide: 'right', strongerLabel: 'Right Arm' },
};

describe('titan’s optional fatigue fields are all accounted for (VMCP-03.06)', () => {
  it('holds the optional inventory at tsc time', () => {
    // The real assertions are the two type annotations above; these keep the values honest
    // (a literal nobody reads is a literal someone deletes).
    expect(ACCOUNTED_FOR).toEqual([true, true]);
    expect(everyTitanOptional.plannedReps).toBe(8);
  });
});
