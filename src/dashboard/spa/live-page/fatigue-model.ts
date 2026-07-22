/**
 * Data contract for the live "fatigue card" and the diverging dual-Voltra
 * velocity hero (PROVISIONAL — see the DoD note below).
 *
 * These are the read-models the two in-flight titan components will consume. The
 * components are being hardened in PARALLEL and are NOT merged, so we cannot
 * import their final prop types; instead this module DEFINES the shape the
 * data-path must produce, so the titan prop API can be reconciled against a
 * concrete, well-commented contract rather than a sketch. The mapper in
 * `panels/fatigue-view.ts` projects the store/snapshot onto these types.
 *
 * PROVISIONAL / pre-Gate-2 (titan DoD): the mapper is wired only as a labeled
 * provisional path that validates the data-path and surfaces gaps — it does not
 * claim "done". The one genuine gap it surfaces is the aggregated `verdict`,
 * whose computation is WA's `getSetFatigueVerdict` (the fatigue-verdict module),
 * absent from the installed `@voltras/workout-analytics@1.5.0`. Until WA
 * republishes and voltras-mcp bumps, `verdict` is `null` (see the mapper).
 *
 * Units: every velocity here is m/s and every distance is metres — converted
 * from WA's native mm/s & mm at the mapper boundary, exactly as the existing
 * live-view mapping does. WA-side `load` is 0 (the bridge never populates it), so
 * there is deliberately NO force/impulse/power dimension on this contract.
 *
 * Tone/state vocabularies mirror WA's `DimensionTone` / `FatigueVerdictState`
 * one-for-one, so the eventual WA verdict drops straight in.
 */

/** Per-dimension status light. Mirrors WA's `DimensionTone`. */
export type DimensionTone = 'ok' | 'warn' | 'alarm';

/** Aggregated verdict state (drives the label). Mirrors WA's `FatigueVerdictState`. */
export type FatigueVerdictState = 'good' | 'slowing' | 'grinding' | 'form-breakdown';

/** Movement phase of one per-sample point — colors the ghost-spark zero-axis. */
export type SamplePhase = 'concentric' | 'eccentric' | 'idle';

/** One per-sample point of a rep's velocity-time curve. */
export interface VelocitySample {
  /** Milliseconds since this rep's first sample. */
  tMs: number;
  /** Instantaneous velocity magnitude, m/s (converted from native mm/s). */
  velocityMps: number;
  /** Movement phase at this sample — drives the phase-colored zero-axis segment. */
  phase: SamplePhase;
}

/** A contiguous same-phase run within a rep's sample stream — one zero-axis segment. */
export interface PhaseSegment {
  phase: SamplePhase;
  /** Start offset, ms since the rep's first sample. */
  startMs: number;
  /** End offset, ms since the rep's first sample. */
  endMs: number;
}

/**
 * One rep's velocity-time curve for the ghost-spark (current rep drawn solid,
 * prior reps faded).
 */
export interface RepVelocityCurve {
  /** 1-based rep number. */
  repNumber: number;
  /** Per-sample velocity-time points (concentric then eccentric, in stream order). */
  samples: VelocitySample[];
  /** Contiguous phase runs, for the phase-colored zero-axis. */
  phaseSegments: PhaseSegment[];
  /**
   * Tempo-deviation tint, 0..1 — 0 = on-track (green), 1 = off (amber/red) — used
   * to tint the curve line. `null` when there is no target tempo to deviate from.
   * GAP: the deviation metric (per-rep tempo vs prescribed tempo) is not yet
   * defined; the mapper leaves this `null` and the component draws the neutral
   * on-track tint until the tempo-deviation rule lands.
   */
  tempoDeviation: number | null;
}

/** One per-rep point of the ROM-progression mini-chart. */
export interface RepRomPoint {
  /** 1-based rep number. */
  repNumber: number;
  /** Concentric range of motion, metres. */
  romM: number;
}

/**
 * The always-on live fatigue card model for the current set.
 *
 * A `null` return from the mapper means "no set to show". A present model with a
 * `null` `verdict` means the set is warming up (cold start, < 2 reps) OR the WA
 * verdict function is not yet available — the card renders a neutral "warming up".
 */
export interface LiveFatigueModel {
  /**
   * Estimated RPE (exact, unrounded — the consumer rounds to the conventional
   * 0.5). `null` when there is not enough signal (< 2 reps).
   */
  rpe: number | null;
  /** Reps in reserve = 10 − RPE. `null` when `rpe` is `null`. */
  repsInReserve: number | null;
  /**
   * The aggregated verdict + the three per-dimension lights.
   *
   * `null` = warming up / indeterminate. PROVISIONAL: always `null` on the
   * installed WA 1.5.0 (no `getSetFatigueVerdict`); populated once WA republishes
   * with the fatigue-verdict module and voltras-mcp bumps. The shape is WA's
   * `FatigueVerdict` verbatim so the swap is a one-liner in the mapper.
   */
  verdict: {
    state: FatigueVerdictState;
    tone: DimensionTone;
    dimensions: {
      velocityLoss: DimensionTone;
      rom: DimensionTone;
      tempo: DimensionTone;
    };
  } | null;
  /** ROM progression: per-rep ROM points (metres), ordered by rep. */
  romProgression: RepRomPoint[];
  /**
   * The working-range standard the ROM chart draws its reference line at (metres).
   * `null` until a standard is established (needs ≥ 3 reps). PROVISIONAL: computed
   * inline as the trimmed peak ROM (drop rep 1 + the in-progress rep); superseded
   * by WA `getSetWorkingROM` post-bump.
   */
  romWorkingStandardM: number | null;
  /**
   * The short-threshold line the ROM chart draws (metres) = 0.75 × working
   * standard. `null` until the standard is established.
   */
  romShortThresholdM: number | null;
  /** Ghost-spark: per-rep velocity-time curves, oldest first (last = current rep). */
  velocityCurves: RepVelocityCurve[];
  /**
   * Current-rep tempo tuple `[eccentric, pauseBottom, concentric, pauseTop]`
   * seconds — from WA `getSetTempoSeconds` (raw durations; NOT `formatTempo`,
   * whose ordering is a known footgun). `null` when no rep carries timing yet.
   */
  tempoSeconds: [number, number, number, number] | null;
  /**
   * Target tempo tuple, same `[ecc, pauseBottom, con, pauseTop]` ordering, from
   * the prescription. `null` when the plan prescribes none.
   */
  targetTempoSeconds: [number, number, number, number] | null;
}

/** One side (limb) of the diverging dual-Voltra velocity hero. */
export interface DivergingHeroSide {
  /** Per-rep MEAN concentric velocity, m/s, ordered by rep. */
  repVelocitiesMps: number[];
  /**
   * The best (reference) mean concentric velocity for this side, m/s — the datum
   * the per-rep bars diverge from. `null` when the side has no reps.
   */
  bestVelocityMps: number | null;
  /** Velocity-loss % for this side (best → current). `null` when < 2 reps. */
  velocityLossPct: number | null;
}

/**
 * The diverging dual-Voltra velocity hero: left vs right, mirrored around a shared
 * center axis. A `null` side is an unbound slot (an honest "awaiting" limb — never
 * fabricated). `scaleMaxMps` is the shared velocity scale so both limbs read on one
 * axis.
 */
export interface DivergingHeroModel {
  left: DivergingHeroSide | null;
  right: DivergingHeroSide | null;
  /** Shared velocity scale max (m/s). `null` when neither side has any data. */
  scaleMaxMps: number | null;
}
