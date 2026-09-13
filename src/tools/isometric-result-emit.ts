// Publishes the `isometric_result` push event (VW-264) once an isometric assessment has
// finished computing its answer.
//
// Lives beside `isometric-tools.ts` rather than inside it so that file's only change is
// the two call sites at the ends of `measureMax` and `measureImbalance` — the assessment
// tools were under concurrent change (VW-284's setup gate, #375) and this ticket has no
// business in their bodies.
//
// Fire-and-forget by construction: `ChannelPublisher.publish` never throws and a dropped
// push must not fail an assessment the athlete just spent ten minutes producing.

import {
  buildIsometricResultPayload,
  type IsometricResultSide,
  type IsometricVerdict,
} from '../state/channel-payloads.js';
import type { ServerState } from '../state/server-state.js';

/**
 * The imbalance report as `measureImbalance` reports it, after VW-284's setup gate has
 * had its say. `real` is `null` exactly when that gate withheld the verdict.
 */
export interface ImbalanceVerdictSource {
  asymmetryPct: number | null;
  /** True when the difference exceeds the athlete's own intra-limb CV; null when withheld. */
  real: boolean | null;
  interpretation: string;
}

/** The cable-geometry gate's answer (VW-284), as the tool result reports it. */
export interface SetupGateSource {
  comparability: string;
  /** `compareSetupSignatures`' own wording, without the "Verdict withheld:" prefix. */
  reason: string;
}

/**
 * Map an imbalance report onto the published verdict.
 *
 * `null` (no verdict) covers two different silences: no comparison was possible at all
 * (`asymmetryPct === null`, a side short of valid trials), and the setup gate withholding
 * one (`real === null`). Both are honest non-answers and the wall renders each as such
 * rather than as a weak "no difference". `setup_unverified` is NOT one of them — the gate
 * could not run, which the tool result says plainly while reporting the verdict unchanged.
 */
function verdictOf(imbalance: ImbalanceVerdictSource): IsometricVerdict | null {
  if (imbalance.asymmetryPct === null || imbalance.real === null) return null;
  return imbalance.real ? 'meaningful' : 'flagged';
}

/** Publish the verdict from a two-sided assessment (`isometric.measure_imbalance`). */
export function publishImbalanceResult(
  state: ServerState,
  input: {
    sides: readonly IsometricResultSide[];
    imbalance: ImbalanceVerdictSource;
    setup: SetupGateSource;
  },
): void {
  const { imbalance, setup } = input;
  state.channels.publish(
    buildIsometricResultPayload({
      tool: 'isometric.measure_imbalance',
      sides: input.sides,
      asymmetryPct: imbalance.asymmetryPct,
      verdict: verdictOf(imbalance),
      reason: imbalance.interpretation,
      comparability: setup.comparability,
      setupReason: setup.reason,
      occurredAt: Date.now(),
    }),
  );
}

/**
 * Publish the result of a single-sided assessment (`isometric.measure_max`).
 *
 * There is no second limb, so there is no asymmetry and no verdict — the card shows the
 * peak and says what it is. `reason` names that absence rather than leaving it blank.
 */
export function publishMaxResult(
  state: ServerState,
  input: { slot: string; peakForceLbs: number | null },
): void {
  state.channels.publish(
    buildIsometricResultPayload({
      tool: 'isometric.measure_max',
      sides: [{ side: null, slot: input.slot, peakForceLbs: input.peakForceLbs }],
      asymmetryPct: null,
      verdict: null,
      reason:
        input.peakForceLbs === null
          ? 'No peak force: fewer than 2 valid trials.'
          : 'Single-side maximum — one limb was tested, so there is no left/right comparison.',
      occurredAt: Date.now(),
    }),
  );
}
