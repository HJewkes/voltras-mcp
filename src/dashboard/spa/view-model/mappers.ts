/**
 * Shared workout view-model → titan-prop mappers (VMCP-01.52, convergence Track 2).
 *
 * This is the convergence backbone: a canonical, surface-agnostic per-set shape
 * ({@link WorkoutSetView}) plus pure mappers from it onto titan-design component
 * props. The dashboard SPA consumes it today; the mobile app will map its own WA
 * `Set` data into the SAME `WorkoutSetView` and reuse these mappers, so both
 * surfaces derive RPE / velocity identically and render one component set.
 *
 * Deliberately self-contained — it imports only `@voltras/workout-analytics`
 * (runtime math) and titan-design *types* (`import type`, erased at build). No
 * dashboard-specific or React-runtime imports — so it lifts cleanly into a shared
 * `@voltras/workout-view-model` package when a second consumer (mobile) is ready.
 *
 * All VBT math is routed through WA (`getRepPeakVelocity`, `getSetVelocityLossPct`,
 * `estimateSetRIR`) — never hand-rolled. NDA: reads WA view-models only; no
 * protocol bytes / frames / command codes cross this boundary.
 */
import {
  estimateE1RMFromReps,
  estimateSetRIR,
  getPhaseHoldDuration,
  getPhaseMovementDuration,
  getRepPeakVelocity,
  getSetVelocityLossPct,
  type Rep,
} from '@voltras/workout-analytics';
import type { ExerciseCardProps, SetRowProps } from '@titan-design/react-ui';

/** mm/s → m/s divisor (WA velocities arrive in mm/s). */
export const MMS_PER_MPS = 1000;

/**
 * Canonical, surface-agnostic view of one set in a workout timeline. Carries the
 * raw WA `Rep[]` as the source of truth; the mappers derive RPE / per-rep
 * velocity from it via WA so every consumer gets identical numbers. Both the
 * dashboard (from its snapshot accumulator) and mobile (from its `CompletedSet`)
 * can populate this shape.
 */
export interface WorkoutSetView {
  setNumber: number;
  /** `'completed'` = a closed set; `'active'` = the in-progress set. */
  kind: 'completed' | 'active';
  /** Full WA reps (source of truth) — RPE / velocity derive from these. */
  reps: readonly Rep[];
  weightLbs: number | null;
  /** Active-set targets (rep-count trigger + working weight); null for completed. */
  targetReps: number | null;
  targetWeightLbs: number | null;
  /** Prior set's performance, for titan SetRow's PREV column. */
  previous: { reps: number; weightLbs: number } | null;
}

/** Peak concentric velocity (mm/s) for a rep, via WA. Null if unavailable. */
export function repPeakMms(rep: Rep): number | null {
  const v = getRepPeakVelocity(rep);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Convert a mm/s velocity to m/s (2-dp) as a number for chart props. */
export function toMps(mmPerSec: number | null | undefined): number | null {
  if (mmPerSec == null || !Number.isFinite(mmPerSec)) return null;
  return Number((mmPerSec / MMS_PER_MPS).toFixed(2));
}

/**
 * Estimated RPE (10 − RIR) for a set, via WA `estimateSetRIR` (velocity-loss
 * based, never hand-rolled). Needs at least two reps carrying real concentric
 * movement samples; under two reps, or when WA can't derive a finite RIR (e.g.
 * reps with no samples), we return null so titan SetRow renders its em-dash.
 *
 * RPE is a velocity-loss estimate, so it is gated on velocity loss being itself
 * derivable — without real concentric samples `estimateSetRIR` returns a
 * misleading floor (RPE 10) rather than signalling "unknown". Rounded to the
 * nearest 0.5 — RPE's conventional granularity, which also aligns with titan's
 * RPE color bands.
 */
export function deriveRpe(reps: readonly Rep[]): number | null {
  if (reps.length < 2) return null;
  const set = { reps: [...reps] };
  if (!Number.isFinite(getSetVelocityLossPct(set))) return null;
  const { rpe } = estimateSetRIR(set);
  if (!Number.isFinite(rpe)) return null;
  return Math.round(rpe * 2) / 2;
}

/** Per-rep peak velocities (m/s), ordered — for titan's per-row VelocityStrip. */
export function repVelocitiesMps(reps: readonly Rep[]): number[] {
  return reps.map((r) => toMps(repPeakMms(r)) ?? 0);
}

const rnd = (n: number | null): number | null => (n != null ? Math.round(n) : null);

/** Rep count shown on a row: null for an active set with no reps yet, else count. */
function displayRepCount(view: WorkoutSetView): number | null {
  if (view.kind === 'active' && view.reps.length === 0) return null;
  return view.reps.length;
}

/** Map a canonical set view onto titan `SetRow` props. */
export function toSetRowProps(view: WorkoutSetView): SetRowProps {
  const velocities = repVelocitiesMps(view.reps);
  return {
    mode: view.kind,
    setNumber: view.setNumber,
    reps: displayRepCount(view),
    weight: rnd(view.weightLbs),
    rpe: deriveRpe(view.reps),
    unit: 'lbs',
    velocities: velocities.length > 0 ? velocities : undefined,
    previous: view.previous
      ? { reps: view.previous.reps, weight: Math.round(view.previous.weightLbs) }
      : null,
    isNextSet: view.kind === 'active',
    targets:
      view.kind === 'active' && view.targetReps != null && view.targetWeightLbs != null
        ? { reps: view.targetReps, weight: Math.round(view.targetWeightLbs) }
        : undefined,
  };
}

type ExerciseSummary = NonNullable<ExerciseCardProps['summary']>;

/**
 * Map the set-timeline onto titan `ExerciseCard`'s header summary. `sets` counts
 * completed sets; `reps`/`weight` reflect the current target — the active set's
 * rep target when configured, else the last set's actuals (mirrors the mobile
 * app's exercise header).
 */
export function toExerciseSummary(
  views: WorkoutSetView[],
  repTarget: number | null,
): ExerciseSummary {
  const completed = views.filter((v) => v.kind === 'completed').length;
  const last = views[views.length - 1];
  const lastReps = last ? last.reps.length : 0;
  return {
    sets: completed,
    reps: repTarget ?? lastReps,
    weight: rnd(last?.weightLbs ?? null) ?? 0,
    unit: 'lbs',
  };
}

/**
 * Best estimated 1RM across the exercise's sets so far, for the hero card's
 * e1RM badge. Uses WA's rep-based estimate (load × rep-count) per set and takes
 * the max — a live "projected 1RM" that firms up as reps accumulate. Null until
 * a set has both a weight and at least one rep. Rep-based (not profile-based):
 * a single working weight has no load-velocity spread to fit a profile from.
 */
export function deriveExerciseE1RM(
  views: WorkoutSetView[],
): NonNullable<ExerciseCardProps['e1rm']> | null {
  let best: number | null = null;
  for (const v of views) {
    if (v.weightLbs == null || v.reps.length < 1) continue;
    const est = estimateE1RMFromReps(v.weightLbs, v.reps.length).e1RM;
    if (Number.isFinite(est) && (best === null || est > best)) best = est;
  }
  return best === null ? null : { value: Math.round(best), unit: 'lbs' };
}

/**
 * True when the live e1RM beats the best in prior history — a new PR worth a
 * badge on the hero card. Requires a historical baseline: the first-ever session
 * of an exercise is NOT flagged (nothing to beat yet), so the badge means
 * "you just went past your record", not "no record exists".
 */
export function isNewE1RM(current: number | null | undefined, historyBest: number | null): boolean {
  return current != null && historyBest != null && current > historyBest;
}

/** Prescribed targets for the active exercise, matching `/api/session-plan`. */
export interface PrescriptionView {
  repsLow?: number;
  repsHigh?: number;
  weightLbs?: number;
  rpe?: number;
}

/** Human prescription string, e.g. "8–10 @ 62 lb · RPE 8". Null if nothing to show. */
export function formatPrescription(p: PrescriptionView | null): string | null {
  if (p == null) return null;
  let reps: string | null = null;
  if (p.repsLow != null && p.repsHigh != null) {
    reps = p.repsLow === p.repsHigh ? `${p.repsLow}` : `${p.repsLow}–${p.repsHigh}`;
  } else if (p.repsLow != null) {
    reps = `${p.repsLow}`;
  }
  const weight = p.weightLbs != null ? `${p.weightLbs} lb` : null;
  const head = [reps, weight].filter((s): s is string => s != null).join(' @ ');
  const rpe = p.rpe != null ? `RPE ${p.rpe}` : null;
  const full = [head.length > 0 ? head : null, rpe]
    .filter((s): s is string => s != null)
    .join(' · ');
  return full.length > 0 ? full : null;
}

/**
 * Signed % the actual working weight deviates from the prescribed weight — feeds
 * titan DeviationBar (positive = heavier than planned). Null when either weight
 * is missing, so "no prescription" renders nothing rather than a 0% "on plan".
 */
export function weightDeviationPct(
  actualLbs: number | null,
  prescribedLbs: number | null | undefined,
): number | null {
  if (actualLbs == null || prescribedLbs == null || prescribedLbs <= 0) return null;
  return Math.round(((actualLbs - prescribedLbs) / prescribedLbs) * 100);
}

/** Weekly-volume status names (mirror titan's muscle-taxonomy VolumeStatus). */
export type VolumeStatusName = 'under' | 'maintenance' | 'productive' | 'over';

/**
 * Classify weekly effective sets against MEV/MAV/MRV landmarks: below MEV is
 * `under` (not enough to grow), MEV–MAV `maintenance`, MAV–MRV `productive` (the
 * sweet spot), at/above MRV `over` (beyond recoverable volume). Pure — the
 * landmark table lives in titan; this only compares.
 */
export function volumeStatusForSets(
  sets: number,
  landmarks: { mev: number; mav: number; mrv: number },
): VolumeStatusName {
  if (sets < landmarks.mev) return 'under';
  if (sets < landmarks.mav) return 'maintenance';
  if (sets < landmarks.mrv) return 'productive';
  return 'over';
}

const round1 = (x: number): number => (Number.isFinite(x) ? Math.round(x * 10) / 10 : 0);

/**
 * Rep cadence as titan `TempoDisplay`'s `[eccentric, pauseBottom, concentric,
 * pauseTop]` seconds, from the most recent rep carrying real phase timing. Read
 * straight off WA's phase durations (not the getRepTempo string, which rounds to
 * whole seconds and loses sub-second pauses). Returns null when no rep has timing
 * yet — a 0-0-0-0 cadence means "not captured", not "instant", so we hide it.
 */
export function deriveTempo(views: WorkoutSetView[]): [number, number, number, number] | null {
  const last = views[views.length - 1];
  if (last === undefined) return null;
  for (let i = last.reps.length - 1; i >= 0; i--) {
    const rep = last.reps[i];
    const tempo: [number, number, number, number] = [
      round1(getPhaseMovementDuration(rep.eccentric)),
      round1(getPhaseHoldDuration(rep.eccentric)),
      round1(getPhaseMovementDuration(rep.concentric)),
      round1(getPhaseHoldDuration(rep.concentric)),
    ];
    if (tempo.some((v) => v > 0)) return tempo;
  }
  return null;
}
