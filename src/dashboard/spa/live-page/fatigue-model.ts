/**
 * Data contract for the live "fatigue card" and the diverging dual-Voltra
 * velocity hero.
 *
 * The fatigue card's model IS titan's — imported and re-exported below, not
 * mirrored (VMCP-03.06). It used to be a hand-written copy of titan's exported
 * `LiveFatigueModel`, written when the components were still in flight. Required
 * fields drift loudly under that arrangement (tsc catches them); OPTIONAL fields
 * drift in TOTAL SILENCE, because nothing type-checks a prop allowed to be absent
 * and passing a typed VARIABLE (not an object literal) skips excess-property checks
 * too. `plannedReps` did exactly that: titan shipped it in 0.12.0 to drive
 * `RomProgressionChart`'s dashed to-do slots, the copy never grew it, and every set
 * rendered as complete through clean lint, clean tsc on both configs, and a green
 * suite. Importing removes the copy; `__tests__/fatigue-model-contract.test.ts` is
 * the mechanical guard for what importing alone cannot catch.
 *
 * STAYS LOCAL — the SPA-only sub-models titan does not export: the diverging
 * dual-Voltra hero ({@link DivergingHeroModel} / {@link DivergingHeroSide}), the
 * {@link LimbAsymmetry} callout, and the two dual-Voltra fields the card carries
 * beyond titan's shape (see {@link LiveFatigueModel}).
 *
 * The mapper in `panels/fatigue-view.ts` projects the store/snapshot onto these
 * types. Every field is sourced from real WA analytics (`@voltras/workout-analytics`,
 * incl. `getSetFatigueVerdict` / `getSetWorkingROM`); `verdict` is `null` only for a
 * cold-start set (< 2 reps).
 *
 * Units: every velocity here is m/s and every distance is metres — converted from
 * WA's native mm/s & mm at the mapper boundary, exactly as the existing live-view
 * mapping does. WA-side `load` is 0 (the bridge never populates it), so there is
 * deliberately NO force/impulse/power dimension on this contract.
 */
import type {
  LiveFatigueModel as TitanLiveFatigueModel,
  RepVelocityCurve,
} from '@titan-design/react-ui';

/**
 * titan's fatigue sub-models, re-exported so SPA modules keep importing the whole
 * contract from here. Previously mirrored one-for-one; see the module note.
 *
 * `SamplePhase` keeps `hold` distinct from `idle` (#211): titan's `PHASE_AXIS_COLOR`
 * gives them different greys, so folding them together (as this boundary once did)
 * makes a held bottom indistinguishable from nothing happening.
 */
export type {
  DimensionTone,
  FatigueVerdict,
  FatigueVerdictState,
  PhaseSegment,
  RepRomPoint,
  RepVelocityCurve,
  SamplePhase,
  VelocitySample,
} from '@titan-design/react-ui';

/**
 * The left/right performance imbalance callout on the (single, shared) dual-Voltra
 * fatigue card — e.g. "L/R imbalance 8% ▸ Right".
 *
 * Proxy: at a common load, the side moving the bar faster is the stronger/fresher
 * one, so the comparison is over each side's MEAN of its per-rep mean concentric
 * velocities (WA `getRepMeanVelocity` via the adapter's `repMeanVelocityMps`, the
 * same per-rep number the diverging hero plots — no second definition of
 * "rep velocity").
 * There is no force dimension available here (WA-side `load` is 0).
 *
 * DISPLAY ONLY: never persisted, and never a clinical/injury claim.
 */
export interface LimbAsymmetry {
  /** Magnitude, percent of the stronger side: |L − R| / max(L, R) × 100, 0..100. */
  pct: number;
  /** The side with the higher mean concentric velocity. */
  strongerSide: 'left' | 'right';
  /** User-facing label for {@link strongerSide}, from the shared `limbLabel()` helper. */
  strongerLabel: string;
}

/**
 * The always-on live fatigue card model for the current set — titan's exported
 * `LiveFatigueModel` plus the two dual-Voltra fields the SPA adds.
 *
 * IMPORTED, not mirrored (VMCP-03.06). Every field titan declares — including any
 * OPTIONAL one it adds in a future release — arrives here for free, so the mapper
 * can no longer silently omit one the way it omitted `plannedReps`. See the module
 * note and `__tests__/fatigue-model-contract.test.ts`.
 *
 * The intersection is the SPA's own extension, not a mirror: `contributingLimbCount`
 * and {@link asymmetry} are dual-Voltra facts titan's card does not model. Object
 * literals typed as this intersection still get excess-property checking, which is
 * what the guard relies on.
 *
 * A `null` return from the mapper means "no set to show". A present model with a
 * `null` `verdict` means the set is warming up (cold start, < 2 reps) — the card
 * renders a neutral "warming up".
 *
 * DUAL-VOLTRA: there is exactly ONE of these cards even when two devices are live.
 * Its verdict, RPE and three dimension lights describe the ATHLETE AS A WHOLE (see
 * the mapper for how the two limbs' per-rep observations are folded into one set);
 * the only per-limb thing on it is {@link asymmetry}. Per-limb detail belongs to the
 * diverging hero and the ghost-spark, not here.
 */
export type LiveFatigueModel = TitanLiveFatigueModel & {
  /**
   * How many devices contributed reps to this card (0, 1, or 2+). The card uses it
   * to tell "single Voltra — imbalance is not a thing here" (`< 2`) apart from "two
   * Voltras live but the imbalance could not be computed" (`>= 2` with a `null`
   * {@link asymmetry}), so the latter can render an explicit gap.
   */
  contributingLimbCount: number;
  /**
   * The L/R imbalance callout. `null` whenever it cannot be computed HONESTLY:
   * a single Voltra, both live devices resolving to the same side or to no side at
   * all (an unbound slot — we never guess which arm is which), or a side with no
   * usable mean velocity. A gap beats a guess.
   */
  asymmetry: LimbAsymmetry | null;
};

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
   * THIS LIMB's per-rep velocity-time curves, oldest first (last = current rep) — the
   * side's wing of titan's `DualGhostSpark` (VMCP-04.06).
   *
   * Deliberately per-slot and NOT the shared card's {@link LiveFatigueModel.velocityCurves}:
   * that one is built from `foldLimitingReps`, a per-rep-number fold that keeps only the
   * slower observation, so its curve for rep N may come from the left arm and its curve for
   * rep N+1 from the right. That is the correct athlete-level read and exactly the WRONG
   * thing to draw as one limb's shape. These come straight off the slot's own reps.
   *
   * Empty for a rep stream that carries no per-sample data (a summary-only rep), which is
   * a real wire state — see the mapper's `samplesOf`. Empty is the honest reading; the
   * stage declines to draw the spark at all rather than plotting a flat fabricated line.
   */
  velocityCurves: RepVelocityCurve[];
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
  /**
   * Shared velocity scale max (m/s) — the higher of the two sides' bests. `null` when
   * neither side has data.
   *
   * ⚠ It does NOT feed the component `scale`, despite what this comment claimed until
   * VMCP-04.05 actually built the stage. The shipped `DualVelocityStrip` prop is
   * `'peak' | 'fixed'`, not a number, and `scale="peak"` already derives the pair's
   * shared ceiling internally — the same quantity. The stage uses the component's own
   * derivation so there is ONE definition of that ceiling rather than two that can
   * drift apart. This field stays the datum the diverging bars are described against.
   */
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
