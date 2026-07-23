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
 * provisional path that validates the data-path — it does not claim "done" and no
 * component renders it yet. Every field is now sourced from real WA analytics
 * (`@voltras/workout-analytics` 1.7.0, incl. `getSetFatigueVerdict` /
 * `getSetWorkingROM`); `verdict` is `null` only for a cold-start set (< 2 reps).
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
 *
 * The line color is driven by TWO normalized per-rep signals (the "green-intensity
 * control-aware" rule). The mapper provides the numbers; the color MAPPING lives in
 * the ghost-spark component. Component logic (for reference, not this layer's code):
 * `grindSignature < ~0.35` → stay green, intensity by `tempoDeviation` (brightest at
 * 0 → deepest green at 1, hue held); otherwise → warm hue amber (at 0.35) → red (at
 * 1.0) by `grindSignature`. So a slow-but-smooth rep stays green (just deeper); only
 * a stalling/collapsing rep warms.
 */
export interface RepVelocityCurve {
  /** 1-based rep number. */
  repNumber: number;
  /** Per-sample velocity-time points (concentric then eccentric, in stream order). */
  samples: VelocitySample[];
  /** Contiguous phase runs, for the phase-colored zero-axis. */
  phaseSegments: PhaseSegment[];
  /**
   * Normalized concentric-duration deviation from the prescribed tempo, 0..1
   * (0 = on-tempo, 1 = well off). Drives GREEN INTENSITY when the rep is controlled.
   * `null` when there is no prescribed tempo to deviate from (nothing to compare to).
   */
  tempoDeviation: number | null;
  /**
   * Normalized velocity COLLAPSE within the concentric, 0..1 (0 = smooth, 1 = full
   * collapse) — the peak → mid-concentric-trough drop, ignoring the natural lockout
   * taper (the `getPhaseVelocityDropPct` concept, measured over a window that drops
   * the ramp-up and the lockout tail so a smooth rep reads ~0). Warms the line hue
   * amber→red past the control threshold. Always computed per rep (no prescription
   * needed); a rep with too few concentric samples reads `0`.
   */
  grindSignature: number;
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
   * The aggregated verdict + the three per-dimension lights, from WA
   * `getSetFatigueVerdict` (velocity/ROM/tempo with strict precedence so a
   * clean-looking velocity cannot mask a cheat rep). `null` = warming up (a
   * cold-start set, < 2 reps). The shape is WA's `FatigueVerdict` verbatim.
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
   * The working-range standard the ROM chart draws its reference line at (metres),
   * from WA `getSetWorkingROM` (trimmed peak: drop rep 1 + the in-progress rep).
   * `null` until a standard is established (needs ≥ 3 reps).
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

/**
 * One side (limb) of the diverging dual-Voltra velocity hero.
 *
 * Reconciled with titan's `DualVelocityStream` (hero cleared Gate-2, titan #120):
 * `repVelocitiesMps` → the component's `velocities`, `label` → its `label`. The
 * rich `set` slot descriptor (`VelocitySet` — done/todo/range/amrap/myo rendering)
 * is a FUTURE add: the live dual path takes the simple `velocities` array today
 * (and is thin anyway while the SSE hub is slot-blind, VW-48), so it is not built
 * here yet. `bestVelocityMps` / `velocityLossPct` have no direct titan prop; they
 * are kept for the diverging datum + the per-limb verdict/loss context.
 */
export interface DivergingHeroSide {
  /** Per-rep MEAN concentric velocity, m/s, ordered by rep. Feeds the component `velocities`. */
  repVelocitiesMps: number[];
  /**
   * The bound limb/device label for this side (feeds the component `label`) — the
   * device identity on this slot. `null` when the slot carries no device identity.
   *
   * DATA GAP: the intended label is a friendly user-assigned slot/limb name (e.g.
   * "Left Arm"), which is not on the /api/snapshot wire today — the mapper falls back
   * to the device serial. A real friendly name would need surfacing from the slot
   * binding (slot_bind / slot_identify). See the mapper note.
   */
  label: string | null;
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
 * fabricated).
 *
 * Reconciled with titan's diverging hero props (titan #120): `left`/`right` →
 * `DualVelocityStream` sides, `scaleMaxMps` → the component `scale`, `targetReps` →
 * the planned dashed-stub count, `liveRepIndex` → the live-rep pop. The component's
 * optional `zones` (velocity-zone bands) is a FUTURE add — not built here yet.
 */
export interface DivergingHeroModel {
  left: DivergingHeroSide | null;
  right: DivergingHeroSide | null;
  /** Shared velocity scale max (m/s), feeds the component `scale`. `null` when neither side has data. */
  scaleMaxMps: number | null;
  /**
   * Planned rep target for the dashed stubs (feeds the component `targetReps`).
   * `null` when the session carries no prescription. Sourced from the prescription's
   * low rep bound (the committed planned count).
   */
  targetReps: number | null;
  /**
   * 0-based index of the current (latest) rep across the bound limbs — drives the
   * live-rep pop (feeds the component `liveRepIndex`). `null` when no bound side has
   * landed a rep yet.
   */
  liveRepIndex: number | null;
}
