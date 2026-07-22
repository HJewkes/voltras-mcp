/**
 * Store → fatigue-card / diverging-hero adapter (PROVISIONAL SPIKE — titan DoD).
 *
 * Projects the store slices onto the {@link LiveFatigueModel} / {@link
 * DivergingHeroModel} data contract (`../live-page/fatigue-model`). Pure
 * projection — no I/O, no component imports — the sibling of
 * `live-view.ts:mapStoreToDashboardModel`.
 *
 * Why this is labeled PROVISIONAL:
 *   1. The titan components it feeds are being hardened in parallel and are not
 *      merged, so their final prop types cannot be imported — this validates the
 *      data-path against a proposed contract, it does not finalize it.
 *   2. The aggregated `verdict` is WA `getSetFatigueVerdict` (the fatigue-verdict
 *      module), absent from the installed `@voltras/workout-analytics@1.5.0`.
 *      Until WA republishes and voltras-mcp bumps, `verdict` stays `null` and the
 *      card renders "warming up". The `romWorkingStandardM` is likewise computed
 *      inline here as a stand-in for WA `getSetWorkingROM` until the bump.
 *
 * Everything else the card/hero need IS available today: the full WA `Rep[]`
 * (with per-sample streams) already crosses `/api/snapshot`, and per-rep ROM,
 * the tempo tuple, velocity loss, and RPE all derive from the installed WA.
 *
 * Units: velocities → m/s, distances → m, converted from WA-native mm/s & mm at
 * this boundary (as the existing live-view mapping does). No force/impulse/power
 * dimension — WA-side per-sample `load` is 0 (the bridge never populates it).
 */
import {
  estimateSetRpe,
  getRepRangeOfMotion,
  getSetRepROMs,
  getSetTempoSeconds,
  getSetVelocityLossPct,
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

/** One rep's velocity-time curve (concentric then eccentric, in stream order). */
function buildVelocityCurve(rep: Rep, repNumber: number): RepVelocityCurve {
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
    // GAP: the per-rep tempo-deviation tint rule is not yet defined; the component
    // draws the neutral on-track tint until it lands. See the contract note.
    tempoDeviation: null,
  };
}

/**
 * The working ROM standard (metres) — PROVISIONAL stand-in for WA `getSetWorkingROM`:
 * trim rep 1 (setup) and the last (in-progress/truncated) rep, take the peak of the
 * remaining reps. `null` until ≥ 3 reps establish a middle. Superseded by the WA
 * function post-bump (same trim policy, so the value is stable across the swap).
 */
function workingRomMetres(reps: readonly Rep[]): number | null {
  const roms = getSetRepROMs({ reps: reps as Rep[] });
  if (roms.length < 3) return null;
  const established = roms.slice(1, -1).filter((r) => Number.isFinite(r) && r > 0);
  if (established.length === 0) return null;
  return toMetres(Math.max(...established));
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

  return {
    rpe,
    repsInReserve: rpe == null ? null : Number((10 - rpe).toFixed(2)),
    // PROVISIONAL: WA `getSetFatigueVerdict` is not in the installed 1.5.0. Swap to
    //   verdict: reps.length < 2 ? null : getSetFatigueVerdict({ reps })
    // once WA republishes with the fatigue-verdict module and voltras-mcp bumps.
    verdict: null,
    romProgression: romProgression(reps),
    romWorkingStandardM: workingStandard,
    romShortThresholdM:
      workingStandard == null ? null : Number((workingStandard * 0.75).toFixed(3)),
    velocityCurves: reps.map((rep, i) => buildVelocityCurve(rep, rep.repNumber ?? i + 1)),
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
