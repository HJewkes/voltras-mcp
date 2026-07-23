/**
 * Store → fatigue-card / diverging-hero adapter (PROVISIONAL SPIKE — titan DoD).
 *
 * Projects the store slices onto the {@link LiveFatigueModel} / {@link
 * DivergingHeroModel} data contract (`../live-page/fatigue-model`). Pure
 * projection — no I/O, no component imports — the sibling of
 * `live-view.ts:mapStoreToDashboardModel`.
 *
 * Why this is still labeled PROVISIONAL: the titan components it feeds are being
 * hardened in parallel and are not merged, so their final prop types cannot be
 * imported — this validates the real data-path against a proposed contract, it
 * does not finalize it, and no component renders it yet.
 *
 * The data path is now REAL end to end: the full WA `Rep[]` (with per-sample
 * streams) crosses `/api/snapshot`, and every model field — the multi-dimension
 * `verdict` (WA `getSetFatigueVerdict`), the working-ROM standard (WA
 * `getSetWorkingROM`), per-rep ROM, the tempo tuple, velocity loss, and RPE — is
 * computed from `@voltras/workout-analytics` (bumped to 1.7.0 for the verdict).
 *
 * Units: velocities → m/s, distances → m, converted from WA-native mm/s & mm at
 * this boundary (as the existing live-view mapping does). No force/impulse/power
 * dimension — WA-side per-sample `load` is 0 (the bridge never populates it).
 */
import {
  estimateSetRpe,
  getRepConcentricTime,
  getRepRangeOfMotion,
  getSetFatigueVerdict,
  getSetTempoSeconds,
  getSetVelocityLossPct,
  getSetWorkingROM,
  MovementPhase,
  type Rep,
} from '@voltras/workout-analytics';
import {
  MMS_PER_MPS,
  repMeanMms,
  toMps,
  type Snapshot,
  type SnapshotDeviceEntry,
} from '../adapter';
import { type LiveViewSources } from './live-view';
import {
  type DivergingHeroModel,
  type DivergingHeroSide,
  type LiveFatigueModel,
  type PhaseSegment,
  type RepRomPoint,
  type RepVelocityCurve,
  type SamplePhase,
  type VelocitySample,
} from '../live-page/fatigue-model';

/** One WA per-sample record, typed via indexed access to avoid a runtime import. */
type Sample = Rep['concentric']['samples'][number];

/** Native mm → m. */
function toMetres(mm: number): number {
  return Number((mm / MMS_PER_MPS).toFixed(3));
}

/** WA `MovementPhase` enum → the contract's spelled-out sample phase. */
function mapSamplePhase(phase: Sample['phase']): SamplePhase {
  switch (phase) {
    case MovementPhase.CONCENTRIC:
      return 'concentric';
    case MovementPhase.ECCENTRIC:
      return 'eccentric';
    default:
      // IDLE and HOLD both read as a neutral pause on the zero-axis.
      return 'idle';
  }
}

/** Fold an ordered sample list into contiguous same-phase runs (the axis segments). */
function toPhaseSegments(samples: readonly VelocitySample[]): PhaseSegment[] {
  const segments: PhaseSegment[] = [];
  for (const s of samples) {
    const last = segments[segments.length - 1];
    if (last && last.phase === s.phase) {
      last.endMs = s.tMs;
    } else {
      segments.push({ phase: s.phase, startMs: s.tMs, endMs: s.tMs });
    }
  }
  return segments;
}

/** Clamp to the unit interval. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Normalized concentric-duration deviation from the prescribed tempo, 0..1.
 * `null` when there is no prescribed concentric target to compare against.
 */
function tempoDeviationFor(rep: Rep, targetConcSec: number | null): number | null {
  if (targetConcSec == null || targetConcSec <= 0) return null;
  const actual = getRepConcentricTime(rep); // seconds (raw duration, NOT formatTempo)
  if (!Number.isFinite(actual) || actual <= 0) return null;
  return Number(clamp01(Math.abs(actual - targetConcSec) / targetConcSec).toFixed(3));
}

/**
 * Normalized velocity collapse within the concentric, 0..1 — the peak → mid-trough
 * drop, ignoring the natural lockout taper. The `getPhaseVelocityDropPct` concept
 * measured over a window that drops the first sample (ramp-up) and the trailing
 * ~20% (lockout taper), so a smooth rep (velocity holds near its own peak through
 * the middle) reads ~0 while a mid-rep stall reads high. Ratio → unit-invariant.
 */
function grindSignatureFor(rep: Rep): number {
  const vels = rep.concentric.samples.map((s) => Math.abs(s.velocity)).filter(Number.isFinite);
  if (vels.length < 3) return 0;
  const peak = Math.max(...vels);
  if (peak <= 0) return 0;
  const tail = Math.max(1, Math.floor(vels.length * 0.2));
  const middle = vels.slice(1, vels.length - tail);
  if (middle.length === 0) return 0;
  const trough = Math.min(...middle);
  return Number(clamp01((peak - trough) / peak).toFixed(3));
}

/** One rep's velocity-time curve (concentric then eccentric, in stream order). */
function buildVelocityCurve(
  rep: Rep,
  repNumber: number,
  targetConcSec: number | null,
): RepVelocityCurve {
  const ordered: Sample[] = [...rep.concentric.samples, ...rep.eccentric.samples];
  const base = ordered.length > 0 ? ordered[0].timestamp : 0;
  const samples: VelocitySample[] = ordered.map((s) => ({
    tMs: s.timestamp - base,
    velocityMps: Number((Math.abs(s.velocity) / MMS_PER_MPS).toFixed(3)),
    phase: mapSamplePhase(s.phase),
  }));
  return {
    repNumber,
    samples,
    phaseSegments: toPhaseSegments(samples),
    tempoDeviation: tempoDeviationFor(rep, targetConcSec),
    grindSignature: grindSignatureFor(rep),
  };
}

/**
 * The working ROM standard (metres) — WA `getSetWorkingROM` (trimmed peak: drop
 * rep 1 + the in-progress/last rep; `null` until ≥ 3 reps establish a middle),
 * converted from WA-native mm to metres at this boundary.
 */
function workingRomMetres(reps: readonly Rep[]): number | null {
  const standardMm = getSetWorkingROM({ reps: reps as Rep[] });
  return standardMm == null ? null : toMetres(standardMm);
}

/** The per-rep ROM progression (metres), skipping reps with no finite ROM. */
function romProgression(reps: readonly Rep[]): RepRomPoint[] {
  const out: RepRomPoint[] = [];
  reps.forEach((rep, i) => {
    const mm = getRepRangeOfMotion(rep);
    if (Number.isFinite(mm)) out.push({ repNumber: rep.repNumber ?? i + 1, romM: toMetres(mm) });
  });
  return out;
}

/**
 * Project the store onto the live fatigue-card model. Returns `null` when there is
 * no active set to show. A present model with `verdict: null` is the warming-up /
 * pre-WA-bump state — the card shows a neutral "warming up".
 */
export function mapStoreToFatigueModel(sources: LiveViewSources): LiveFatigueModel | null {
  const { snapshot, prescription } = sources;
  const active = snapshot?.sets.active;
  if (!snapshot || !active) return null;

  const reps: readonly Rep[] = active.reps ?? [];
  const rpe = estimateSetRpe({ reps: reps as Rep[] });
  const workingStandard = workingRomMetres(reps);
  // Prescribed concentric duration (seconds) — the [ecc, pauseBottom, con, pauseTop]
  // tuple's index 2 — is the reference the per-rep tempo-deviation tint compares to.
  const targetConcSec = prescription?.tempo?.[2] ?? null;

  return {
    rpe,
    repsInReserve: rpe == null ? null : Number((10 - rpe).toFixed(2)),
    // The multi-dimension verdict from WA (velocity/ROM/tempo with strict precedence).
    // `null` for a cold-start set (< 2 reps) — mirrors `getSetFatigueVerdict`'s own gate
    // — which the card renders as a neutral "warming up".
    verdict: reps.length < 2 ? null : getSetFatigueVerdict({ reps: reps as Rep[] }),
    romProgression: romProgression(reps),
    romWorkingStandardM: workingStandard,
    romShortThresholdM:
      workingStandard == null ? null : Number((workingStandard * 0.75).toFixed(3)),
    velocityCurves: reps.map((rep, i) =>
      buildVelocityCurve(rep, rep.repNumber ?? i + 1, targetConcSec),
    ),
    tempoSeconds: getSetTempoSeconds({ reps: reps as Rep[] }),
    targetTempoSeconds: prescription?.tempo ?? null,
  };
}

// --- Diverging dual-Voltra velocity hero -------------------------------------

/** One limb's diverging-hero side from its slot device entry. `null` when unbound. */
function buildHeroSide(entry: SnapshotDeviceEntry | undefined): DivergingHeroSide | null {
  if (entry === undefined) return null;
  const reps: readonly Rep[] = entry.sets?.active?.reps ?? [];
  const velocities: number[] = [];
  for (const rep of reps) {
    const mps = toMps(repMeanMms(rep));
    if (mps !== null) velocities.push(mps);
  }
  const best = velocities.length > 0 ? Math.max(...velocities) : null;
  const velocityLossPct = reps.length < 2 ? null : getSetVelocityLossPct({ reps: reps as Rep[] });
  return { repVelocitiesMps: velocities, bestVelocityMps: best, velocityLossPct };
}

function slotEntry(snapshot: Snapshot, slotId: string): SnapshotDeviceEntry | undefined {
  return snapshot.devices.find((d) => d.slotId === slotId);
}

/**
 * Project the store onto the diverging dual-Voltra velocity hero model. Left/right
 * map to the `'left'`/`'right'` slot ids; an unbound slot yields a `null` side (an
 * honest awaiting limb). `scaleMaxMps` is the shared axis max across both sides.
 */
export function mapStoreToDivergingHeroModel(sources: LiveViewSources): DivergingHeroModel {
  const { snapshot } = sources;
  if (!snapshot) return { left: null, right: null, scaleMaxMps: null };

  const left = buildHeroSide(slotEntry(snapshot, 'left'));
  const right = buildHeroSide(slotEntry(snapshot, 'right'));
  const peaks = [left?.bestVelocityMps, right?.bestVelocityMps].filter(
    (v): v is number => typeof v === 'number',
  );
  return { left, right, scaleMaxMps: peaks.length > 0 ? Math.max(...peaks) : null };
}
