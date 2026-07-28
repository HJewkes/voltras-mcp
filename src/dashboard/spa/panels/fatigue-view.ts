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
 *
 * Dual-Voltra (VMCP-04.04): the fatigue card stays SINGLE and SHARED — it reads the
 * athlete, not a limb. Two live devices are folded to one rep stream before any
 * analytics run (see `foldLimitingReps`), and the only per-limb figure on the card
 * is the L/R imbalance (`buildAsymmetry`). Limbs are matched by their device entry's
 * resolved side via `../limb`, never by slot position.
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
import { limbLabel, limbSide } from '../limb';
import { type LiveViewSources } from './live-view';
import {
  type DivergingHeroModel,
  type DivergingHeroSide,
  type LimbAsymmetry,
  type LiveFatigueModel,
  type PhaseSegment,
  type RepRomPoint,
  type RepVelocityCurve,
  type SamplePhase,
  type VelocitySample,
} from '../live-page/fatigue-model';

/** One WA per-sample record, typed via indexed access to avoid a runtime import. */
type Sample = Rep['concentric']['samples'][number];

/**
 * A phase's sample stream, or an empty one when the wire did not carry it.
 *
 * WA types `samples` as a required array, but this data arrives as JSON over
 * `/api/snapshot` and is typed by ASSERTION, not validation — so the type is a claim
 * about the producer, not a guarantee about the bytes. A rep summary without its
 * per-sample stream is legitimate (a summary-only rep, an older firmware, a driver
 * that reports counts but not curves), and it used to throw
 * `concentric.samples is not iterable` the moment anything read it.
 *
 * That went unnoticed because `mapStoreToFatigueModel` had no app caller until the
 * diverging dual stage (VMCP-04.05) wired it in — the tests all built reps WITH
 * samples. Degrading to an empty stream is the honest reading: no curve and no grind
 * signature, rather than a crash or a fabricated one.
 */
function samplesOf(phase: { samples?: readonly Sample[] } | undefined): readonly Sample[] {
  return phase?.samples ?? [];
}

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
  const vels = samplesOf(rep.concentric)
    .map((s) => Math.abs(s.velocity))
    .filter(Number.isFinite);
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
  const ordered: Sample[] = [...samplesOf(rep.concentric), ...samplesOf(rep.eccentric)];
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

// --- Dual-Voltra: ONE shared card, folded from both limbs ---------------------

/** A device that is mid-set right now, with the reps it has logged for that set. */
interface LiveLimb {
  entry: SnapshotDeviceEntry;
  reps: readonly Rep[];
}

/**
 * The devices with a set in progress (VW-71 per-slot sets). Order is snapshot
 * order; identity is the device entry itself — never a slot position.
 */
function liveLimbs(snapshot: Snapshot): LiveLimb[] {
  const limbs: LiveLimb[] = [];
  for (const entry of snapshot.devices) {
    const activeSet = entry.sets?.active;
    if (activeSet) limbs.push({ entry, reps: activeSet.reps ?? [] });
  }
  return limbs;
}

/** A rep's 1-based number, falling back to its position in its own limb's stream. */
function repNumberOf(rep: Rep, index: number): number {
  return rep.repNumber ?? index + 1;
}

/**
 * Fold two-or-more limbs' per-rep observations into the ONE rep stream the card
 * describes, by taking each rep number's LIMITING observation: of the reps the
 * limbs logged as rep N, the one with the lowest mean concentric velocity.
 *
 * Why limiting rather than averaging or picking a lead arm: on a bilateral effort
 * the athlete's set is governed by the side that is failing, and every quantity on
 * this card (verdict, RPE, ROM standard, velocity loss, tempo) is a fatigue
 * reading — averaging would let a fresh side mask a collapsing one, and picking one
 * arm would throw away the half of the evidence that matters. The fold happens
 * BEFORE any analytics call, so the card still runs the single-Voltra pipeline
 * exactly once per quantity.
 *
 * Reps a limb never logged contribute nothing (no fabricated counterpart), so an
 * unequal rep count simply means those rep numbers come from one limb. A rep with
 * no finite mean velocity loses to one that has a reading; if none does, the first
 * limb in snapshot order stands in.
 */
function foldLimitingReps(limbs: readonly LiveLimb[]): Rep[] {
  const byRepNumber = new Map<number, Rep>();
  for (const limb of limbs) {
    limb.reps.forEach((rep, index) => {
      const n = repNumberOf(rep, index);
      const incumbent = byRepNumber.get(n);
      if (incumbent === undefined || isMoreLimiting(rep, incumbent)) byRepNumber.set(n, rep);
    });
  }
  return [...byRepNumber.entries()].sort(([a], [b]) => a - b).map(([, rep]) => rep);
}

/** True when `candidate` is the more fatigued (slower) of the two observations. */
function isMoreLimiting(candidate: Rep, incumbent: Rep): boolean {
  const a = repMeanMms(candidate);
  const b = repMeanMms(incumbent);
  if (a === null) return false;
  if (b === null) return true;
  return a < b;
}

/** Mean of a limb's per-rep mean concentric velocities, m/s. `null` when none is finite. */
function meanRepVelocityMps(reps: readonly Rep[]): number | null {
  const means: number[] = [];
  for (const rep of reps) {
    const mms = repMeanMms(rep);
    if (mms !== null) means.push(mms);
  }
  if (means.length === 0) return null;
  return toMps(means.reduce((sum, v) => sum + v, 0) / means.length);
}

/**
 * The L/R imbalance callout, or `null` when it cannot be stated honestly.
 *
 * Null cases, all deliberate: fewer than two live limbs; the live limbs do not
 * resolve to exactly one left and one right (an unbound slot has no side, and we do
 * NOT guess which arm is which); or a side has no finite mean velocity yet. A gap
 * beats a guess.
 *
 * At an exact tie `pct` is 0 and `strongerSide` carries no meaning — the card should
 * read 0% as "balanced", not as a verdict about that side.
 */
function buildAsymmetry(limbs: readonly LiveLimb[]): LimbAsymmetry | null {
  if (limbs.length < 2) return null;
  const left = limbs.filter((limb) => limbSide(limb.entry) === 'left');
  const right = limbs.filter((limb) => limbSide(limb.entry) === 'right');
  if (left.length !== 1 || right.length !== 1) return null;

  const leftMps = meanRepVelocityMps(left[0].reps);
  const rightMps = meanRepVelocityMps(right[0].reps);
  if (leftMps === null || rightMps === null) return null;
  const reference = Math.max(leftMps, rightMps);
  if (reference <= 0) return null;

  const leftIsStronger = leftMps >= rightMps;
  const stronger = leftIsStronger ? left[0] : right[0];
  return {
    pct: Number(((Math.abs(leftMps - rightMps) / reference) * 100).toFixed(1)),
    strongerSide: leftIsStronger ? 'left' : 'right',
    strongerLabel: limbLabel(stronger.entry),
  };
}

/**
 * Project the store onto the live fatigue-card model. Returns `null` when there is
 * no active set to show. A present model with `verdict: null` is the warming-up /
 * pre-WA-bump state — the card shows a neutral "warming up".
 *
 * DUAL-VOLTRA: still ONE model. When two devices are mid-set, the rep stream every
 * quantity is computed from is {@link foldLimitingReps}' per-rep limiting fold, so
 * the verdict/RPE/lights describe the athlete as a whole; the single per-limb figure
 * is {@link buildAsymmetry}'s L/R imbalance. With one device (or none reporting
 * per-slot sets) the top-level active set is used and the output is byte-for-byte
 * what it was before dual support.
 */
export function mapStoreToFatigueModel(sources: LiveViewSources): LiveFatigueModel | null {
  const { snapshot, prescription } = sources;
  const active = snapshot?.sets.active;
  if (!snapshot || !active) return null;

  const limbs = liveLimbs(snapshot);
  const isDual = limbs.length >= 2;
  const reps: readonly Rep[] = isDual ? foldLimitingReps(limbs) : (active.reps ?? []);
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
    contributingLimbCount: limbs.length,
    asymmetry: buildAsymmetry(limbs),
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
  return {
    repVelocitiesMps: velocities,
    // PROVISIONAL: the bound device serial (e.g. "V-097082") — the only per-slot
    // identity the snapshot carries client-side. `null` when the slot has no device
    // identity yet.
    // DATA GAP: the intended label is a friendly user-assigned SLOT/LIMB name (e.g.
    // "Left Arm"). No such name is on the /api/snapshot wire today — it would need to
    // be surfaced from the slot binding (slot_bind / slot_identify). Do NOT fall back
    // to the raw 'left'/'right' slotId (that's the hardcoded L/R we moved away from).
    label: entry.device.deviceId ?? null,
    bestVelocityMps: best,
    velocityLossPct,
  };
}

function slotEntry(snapshot: Snapshot, slotId: string): SnapshotDeviceEntry | undefined {
  return snapshot.devices.find((d) => d.slotId === slotId);
}

/** The rep count of a slot's active set (0 when unbound / no active set). */
function activeRepCount(entry: SnapshotDeviceEntry | undefined): number {
  return entry?.sets?.active?.reps?.length ?? 0;
}

/**
 * Project the store onto the diverging dual-Voltra velocity hero model. Left/right
 * map to the `'left'`/`'right'` slot ids; an unbound slot yields a `null` side (an
 * honest awaiting limb). `scaleMaxMps` is the shared axis max across both sides;
 * `targetReps` (planned dashed stubs) comes from the prescription; `liveRepIndex`
 * (live-rep pop) is the latest rep across the bound limbs.
 */
export function mapStoreToDivergingHeroModel(sources: LiveViewSources): DivergingHeroModel {
  const { snapshot, prescription } = sources;
  // PROVISIONAL: planned reps from the prescription's low bound. The single-view
  // (`live-view.ts` / adapter `resolveRepTarget`) sources its `targetReps` from the
  // active set's `rep_count_reached` watch trigger instead — converge the dual onto
  // that same path when the live dual is actually built out.
  const targetReps = prescription?.repsLow ?? null;
  if (!snapshot) {
    return { left: null, right: null, scaleMaxMps: null, targetReps, liveRepIndex: null };
  }

  const leftEntry = slotEntry(snapshot, 'left');
  const rightEntry = slotEntry(snapshot, 'right');
  const left = buildHeroSide(leftEntry);
  const right = buildHeroSide(rightEntry);
  const peaks = [left?.bestVelocityMps, right?.bestVelocityMps].filter(
    (v): v is number => typeof v === 'number',
  );
  // 0-based index of the current (latest) rep across the bound limbs; null before any lands.
  const maxReps = Math.max(activeRepCount(leftEntry), activeRepCount(rightEntry));
  return {
    left,
    right,
    scaleMaxMps: peaks.length > 0 ? Math.max(...peaks) : null,
    targetReps,
    liveRepIndex: maxReps > 0 ? maxReps - 1 : null,
  };
}
