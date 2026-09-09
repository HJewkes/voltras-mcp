// Like-vs-like comparability predicate — v2 of B16 (VW-94, VW-205).
//
// WHAT THIS ANSWERS
// -----------------
// "Were these two sets performed under the same CONTEXT?" — same movement, same
// lifter, same intent, same device settings, same limb, same load. Every trend,
// PR and "you're growing" claim rests on that question, and a naive comparison
// that skips it reports a settings change as progress.
//
// WHAT THIS DOES NOT ANSWER — AND WHY IT DOES NOT DUPLICATE THE DRIFT GUARD
// ------------------------------------------------------------------------
// Context is not execution. Whether the two sets were EXECUTED the same way —
// tempo and ROM within tolerance, the "intentional ROM change" clause of B16 —
// is B15's question and already has an owner: `checkDriftGuard`
// (`store/drift-guard.ts`), surfaced for humans as `driftguard.check`. It reads
// reps; this module reads only the set's context columns and never touches a
// rep. The two layers compose: a pair that this predicate calls comparable can
// still be refused by the drift guard, and a caller wanting both asks both.
// Re-deriving a ROM check here would put two thresholds in the codebase that
// drift apart, which is exactly the failure `set-scope.ts` was extracted to
// avoid.
//
// DEGRADE, NEVER REFUSE SILENTLY
// ------------------------------
// A clause whose value is absent on BOTH sides passes with a note rather than
// blocking, per the backlog's own instruction to degrade rather than refuse.
// The predicate says what it could not check instead of pretending it checked.
//
// The training-phase tag got its writer in VW-149/VW-150
// (`profile.set_diet_phase`), so the phase clause is live on any pair whose
// sessions fall inside a declared range. Absent on both sides — every session
// recorded before the first declaration — still passes with a note, which is
// why old history keeps comparing. `setupId` DOES have one as of VW-119 (`store/exercise-setups.ts`, stamped by
// `stampSetSetup` on `set.end` and by `baselines.recalc { inferSetups: true }`),
// so the setup clause is live on any set that has been clustered. Absent there
// means "not clustered yet", never "the default setup" — which is why a stamp
// on only ONE side blocks: an unclustered set is not evidence of a match.
//
// Strict matching also means few valid pairs for an irregular lifter, so no
// consumer of this module may answer with silence: `chooseComparisonPartner`
// always names the nearest candidate and the reasons it failed.
//
// TWO KINDS OF CLAUSE (v2, VW-205)
// --------------------------------
// B16's remaining clauses are not all context questions, and forcing them into
// one table would make the predicate refuse comparisons it has no business
// refusing. So there are two tables:
//
// - {@link CLAUSES} — CONTEXT clauses. A failure means the pair is not
//   like-vs-like and blocks. (e), the exercise-swap boundary, belongs here: two
//   sets that straddle a re-introduction of the movement were performed in
//   different contexts.
// - {@link CLAIM_CLAUSES} — CLAIM clauses. These qualify a MUSCLE-GAIN claim
//   built on the pair; they never block. (b) across-set profile, (d)
//   multi-exercise corroboration and (f) the early-training neural window all
//   answer "may a growth claim be made from this?", not "is this pair
//   like-vs-like?". Blocking on them would make `session.readiness` refuse a
//   beginner's comparisons outright, which is the failure (f)'s own copy exists
//   to avoid. They emit `'<clause> (note): …'` entries like any other note, so
//   no consumer parses anything new.
//
// Rule (f) is a wording problem before it is a math problem — a beginner who IS
// getting stronger must not read the output as "you are not progressing" — so
// the copy is {@link EARLY_TRAINING_STRENGTH_WORDING}, carried verbatim in the
// reasons the claiming surface already renders.
//
// B16's clause (c) is deliberately absent: it IS B15's tempo/ROM check, whose
// owner is `checkDriftGuard` (see above). No clause here reads a rep, so no
// clause here reads a position and none needs `normalisePositionsToMetres`
// (VW-203) — that normalisation lives with the modules that do read ROM.

import { setPurposeOf, type PurposeBearing } from '../store/set-purpose.js';

/**
 * Percentage tolerance on the load clause, or `null` for exact-load only.
 *
 * `null` IS THE SOURCED VALUE, not a placeholder. The B16 section of
 * `sources/mined/rp-university-idea-backlog.md` and the RP notes it cites name
 * no load tolerance — its "materially" tolerance discussion belongs to B15's
 * tempo/ROM check, which has its own thresholds in `DRIFT_GUARD_THRESHOLDS`.
 * Inventing a percentage here would put an unsourced number at the centre of
 * every progress claim. Exact-load matching is also the sound reading for a
 * progress engine: "same load, more reps" is the inference these consumers
 * make.
 */
export const LOAD_TOLERANCE_PCT: number | null = null;

/**
 * How many distinct exercises for the same muscle must agree before a confident
 * per-muscle growth claim is made.
 *
 * QUOTED FROM B16 clause (d): "requires corroboration across 2-3 exercises for
 * the same muscle before making a confident per-muscle growth claim"
 * (`sources/mined/rp-university-idea-backlog.md`, evidence
 * `rp-s7-multi-exercise-confirmation-for-muscle-gain`). Both ends of the range
 * are kept because the source gives a range: `min` is the gate the clause
 * applies, `max` is quoted back in the note so the reader sees the whole rule
 * rather than a number this module chose.
 */
export const CORROBORATING_EXERCISES = { min: 2, max: 3 } as const;

/**
 * How many sessions the expected post-swap drop takes to settle, or `null` when
 * no duration is sourced.
 *
 * `null` IS THE SOURCED VALUE, like {@link LOAD_TOLERANCE_PCT}. B16 clause (e)
 * asks only that the engine "suppresses/reframes the expected drop after an
 * exercise swap", and the notes it cites for the effect
 * (`rp-s7-novelty-effect-inflates-sfr-temporarily`,
 * `rp-s2-variation-novelty-boosts-overload`) name the effect, not its length.
 * So the swap clause names the BOUNDARY it can see and does not pretend to know
 * when the drop has settled; a number here would put a guess between a lifter
 * and every post-swap comparison.
 */
export const EXERCISE_SWAP_SETTLING_SESSIONS: number | null = null;

/**
 * The reframe B16 (e) asks for, appended to the swap clause's blocking reason.
 *
 * The comparison is refused because the context changed, and the sentence says
 * why the number the lifter would have seen was going to be lower anyway.
 */
export const EXERCISE_SWAP_REFRAME =
  'the drop across a swap is the expected cost of re-learning the movement, not lost progress';

/**
 * The window in which a strength gain is not yet evidence of muscle gained.
 *
 * QUOTED FROM B16 clause (f): "suppresses strength→muscle-gain inference in a
 * user's first ~6-12 months of tracked training, when gains are largely neural"
 * (`sources/mined/rp-university-idea-backlog.md`, evidence
 * `rp-s7-early-strength-gains-not-pure-muscle-signal`). The source gives a
 * range, so both ends are kept: `max` is the gate, because the clause withholds
 * a claim and the conservative end of a quoted range is the one that keeps a
 * wrong claim from shipping, and `min` is quoted back in the wording.
 */
export const NEURAL_GAIN_WINDOW_MONTHS = { min: 6, max: 12 } as const;

/**
 * What a lifter inside {@link NEURAL_GAIN_WINDOW_MONTHS} is told, verbatim.
 *
 * B16 (f) names this the copy problem it is: "Rule (f) will feel wrong to a
 * beginner who *is* getting stronger; that is a copy problem, not a reason to
 * drop it." So the wording leads with the strength being real, then says what
 * is withheld and why — a beginner must never read a withheld muscle-gain claim
 * as "you are not progressing".
 *
 * It is a constant, not a template built at the call site, so the surface that
 * makes the muscle-gain claim carries these exact words and a test can assert
 * them. The months come from the constant above so a threshold change cannot
 * leave the copy quoting a number the code no longer uses.
 */
export const EARLY_TRAINING_STRENGTH_WORDING =
  'you are getting stronger and that strength is real; in the first ' +
  `${NEURAL_GAIN_WINDOW_MONTHS.min} to ${NEURAL_GAIN_WINDOW_MONTHS.max} months of tracked ` +
  'training most of it comes from your nervous system learning the movement rather than from ' +
  'new muscle, so the muscle-gain claim is held back until there is more history behind it — ' +
  'not because the progress has stopped';

/**
 * A set as far as comparability is concerned. Structural, so a `StoredSet`
 * passes without conversion.
 *
 * `setupId` is populated by the VW-119 clustering and `phase` by the VW-150
 * diet-phase writer (see the header); both degrade visibly when absent rather
 * than dropping out of the predicate.
 */
export interface ComparabilitySubject extends PurposeBearing {
  id: string;
  exerciseId?: string | undefined;
  /** Absent means the owner (VW-169), so absent-vs-absent is the same lifter. */
  lifter?: string | undefined;
  trainingMode?: string | undefined;
  settingsHash?: string | undefined;
  side?: string | undefined;
  weightLbs?: number | undefined;
  startedAt?: string | undefined;
  /** Inferred physical configuration (VW-119). Absent ⇒ not clustered yet. */
  setupId?: string | undefined;
  /**
   * Training-phase tag: fat-loss / gain / maintenance (B34). Written by
   * `deriveDietPhase` (VW-150, `comparability-subject.ts`) from the OBSERVED
   * phase covering the set's session — never from a plan week's PRESCRIBED
   * `phase_type`, which is a different claim.
   *
   * Absent means no declared phase covers that session, which is every session
   * recorded before the lifter first declared one.
   */
  phase?: string | undefined;
  /**
   * 1-based position of this set within its EXERCISE's set profile (B16 b).
   * Written by `deriveSetIndexInExercise` (VW-211, `comparability-subject.ts`)
   * from the exercise's other sets in the SAME session.
   *
   * Deliberately not `StoredSet.setIndexInSession`: that ordinal counts across
   * every exercise in the session, so in a multi-exercise session the first set
   * of the second exercise is not index 1. Reading it here would compare
   * positions that mean different things.
   */
  setIndexInExercise?: number | undefined;
  /**
   * How many distinct exercises for the same target muscle back the claim
   * window this set belongs to (B16 d), counting this set's own exercise.
   * Written by `deriveCorroboratingExerciseCount` (VW-211,
   * `comparability-subject.ts`) — the "claim window" is the lifter's entire
   * stored history, since no clause here names a shorter one.
   */
  corroboratingExerciseCount?: number | undefined;
  /**
   * When this exercise entered the programme, as an ISO timestamp (B16 e). Two
   * sets of the same movement carrying DIFFERENT stamps straddle a swap: the
   * movement was dropped and later re-introduced. Written by
   * `deriveExerciseIntroducedAt` (VW-211, `comparability-subject.ts`) as the
   * lifter's first-ever stored set of the exercise — a simple stand-in for a
   * real programme-entry date, which would need plan/program linkage this
   * writer does not have.
   */
  exerciseIntroducedAt?: string | undefined;
  /**
   * Months of TRACKED training behind this set (B16 f) — how long there has
   * been a record, not how long the lifter has trained. Written by
   * `deriveTrackedTrainingMonths` (VW-211, `comparability-subject.ts`) from
   * the lifter's first stored session.
   */
  trackedTrainingMonths?: number | undefined;
}

/**
 * The predicate's answer. `reasons` carries BOTH the blocking reasons and the
 * degrade notes, in clause order, so a caller that only renders `reasons` still
 * tells the user what could not be checked.
 *
 * Entries are prefixed with their clause: `'<clause>: <text>'` blocks the
 * comparison, `'<clause> (note): <text>'` does not.
 */
export interface ComparabilityVerdict {
  comparable: boolean;
  reasons: string[];
}

type ClauseResult = { ok: true; note?: string } | { ok: false; reason: string };

interface Clause {
  name: string;
  evaluate: (a: ComparabilitySubject, b: ComparabilitySubject) => ClauseResult;
}

/**
 * A clause that qualifies a muscle-gain claim rather than the pair's context.
 *
 * `evaluate` returns a note and nothing else — there is no failing branch,
 * because a claim clause has no authority to refuse a comparison. It always has
 * something to say, so the return is a plain string rather than an optional.
 */
interface ClaimClause {
  name: string;
  evaluate: (a: ComparabilitySubject, b: ComparabilitySubject) => string;
}

const OK: ClauseResult = { ok: true };

/** Both sides absent — the degrade case the backlog asks for, kept as a note. */
function bothAbsent(note: string): ClauseResult {
  return { ok: true, note };
}

/**
 * Clause order is the backlog's own: exercise, lifter, purpose, training mode,
 * device settings, side, load, training phase, physical setup.
 */
const CLAUSES: readonly Clause[] = [
  {
    name: 'exercise',
    evaluate: (a, b) => {
      if (a.exerciseId === undefined && b.exerciseId === undefined) {
        return bothAbsent('neither set records an exercise, so the movement is assumed to match');
      }
      if (a.exerciseId !== b.exerciseId) {
        return {
          ok: false,
          reason: `different exercise (${label(a.exerciseId)} vs ${label(b.exerciseId)})`,
        };
      }
      return OK;
    },
  },
  {
    name: 'lifter',
    evaluate: (a, b) =>
      a.lifter === b.lifter
        ? OK
        : { ok: false, reason: `different lifter (${lifterLabel(a)} vs ${lifterLabel(b)})` },
  },
  {
    name: 'purpose',
    evaluate: (a, b) =>
      setPurposeOf(a) === setPurposeOf(b)
        ? OK
        : { ok: false, reason: `different intent (${setPurposeOf(a)} vs ${setPurposeOf(b)} set)` },
  },
  {
    name: 'mode',
    evaluate: (a, b) => matchOrExplain(a.trainingMode, b.trainingMode, 'training mode'),
  },
  {
    name: 'settings',
    evaluate: (a, b) => matchOrExplain(a.settingsHash, b.settingsHash, 'device settings'),
  },
  {
    name: 'side',
    evaluate: (a, b) => matchOrExplain(a.side, b.side, 'side'),
  },
  { name: 'load', evaluate: (a, b) => loadClause(a, b) },
  {
    name: 'phase',
    evaluate: (a, b) => matchOrExplain(a.phase, b.phase, 'training phase'),
  },
  {
    name: 'setup',
    evaluate: (a, b) => matchOrExplain(a.setupId, b.setupId, 'physical setup'),
  },
  { name: 'swap', evaluate: (a, b) => swapClause(a, b) },
];

/**
 * The claim-qualifying clauses, in B16's own order: (b) across-set profile,
 * (d) multi-exercise corroboration, (f) the early-training neural window.
 *
 * Every entry emits a note on every pair. That is the point: a surface that
 * renders `reasons` tells the user what the growth claim rests on, including
 * the parts that could not be checked, without the predicate withholding a
 * comparison it is not entitled to withhold.
 */
const CLAIM_CLAUSES: readonly ClaimClause[] = [
  { name: 'profile', evaluate: (a, b) => profileNote(a, b) },
  { name: 'corroboration', evaluate: (a, b) => corroborationNote(a, b) },
  { name: 'trainingAge', evaluate: (a, b) => trainingAgeNote(a, b) },
];

/**
 * Is this pair like-vs-like? Pure: no store read, no rep math, no clock.
 *
 * Every clause is evaluated — the predicate does not short-circuit — because a
 * caller showing a user why a comparison failed needs the whole list, not the
 * first blocker. The claim clauses run even on an incomparable pair, so the
 * caller sees what a growth claim would have rested on either way.
 */
export function isComparable(
  a: ComparabilitySubject,
  b: ComparabilitySubject,
): ComparabilityVerdict {
  const reasons: string[] = [];
  let comparable = true;
  for (const clause of CLAUSES) {
    const result = clause.evaluate(a, b);
    if (!result.ok) {
      comparable = false;
      reasons.push(`${clause.name}: ${result.reason}`);
    } else if (result.note !== undefined) {
      reasons.push(`${clause.name} (note): ${result.note}`);
    }
  }
  for (const clause of CLAIM_CLAUSES) {
    reasons.push(`${clause.name} (note): ${clause.evaluate(a, b)}`);
  }
  return { comparable, reasons };
}

/**
 * B16 (b): a growth claim must read the whole across-set profile, not the top
 * set of each session.
 *
 * A single pair can never satisfy that on its own — only the caller walking
 * every position can — so this clause states where the pair sits in the profile
 * and leaves the claim to the surface. B16 and the note it cites
 * (`rp-s7-set-average-not-just-top-set`) name no threshold, so there is no
 * constant to cite: the clause reports its raw inputs instead.
 */
function profileNote(a: ComparabilitySubject, b: ComparabilitySubject): string {
  const left = a.setIndexInExercise;
  const right = b.setIndexInExercise;
  if (left === undefined && right === undefined) {
    return (
      'neither set records its position in the exercise set profile, so the top-set-only ' +
      'risk B16 (b) names is unchecked on this pair'
    );
  }
  if (left === undefined || right === undefined) {
    return (
      `set profile position recorded on only one side (${numberLabel(left)} vs ` +
      `${numberLabel(right)}), so this pair cannot be placed in the across-set profile`
    );
  }
  if (left !== right) {
    return (
      `set ${left} compared against set ${right} of their exercise, so a growth claim on this ` +
      'pair alone is a position-mismatched top-set comparison, not an across-set profile'
    );
  }
  return (
    `both sides are set ${left} of their exercise, so this pair is one position of the ` +
    'across-set profile; a confident growth claim still needs the remaining positions'
  );
}

/**
 * B16 (e): two sets of the same movement that straddle its re-introduction were
 * not performed in the same context, so the pair is refused — with the reframe
 * attached, because the lifter's number really was going to be lower.
 *
 * This is a CONTEXT clause, unlike (b), (d) and (f): the swap changed what was
 * performed, not just what may be claimed about it.
 */
function swapClause(a: ComparabilitySubject, b: ComparabilitySubject): ClauseResult {
  const result = matchOrExplain(
    a.exerciseIntroducedAt,
    b.exerciseIntroducedAt,
    'programme entry date for this exercise',
  );
  if (result.ok) return result;
  const unsettled =
    EXERCISE_SWAP_SETTLING_SESSIONS === null
      ? ', and no settling window is sourced, so the clause names the boundary rather than timing it'
      : '';
  return { ok: false, reason: `${result.reason} — ${EXERCISE_SWAP_REFRAME}${unsettled}` };
}

/**
 * B16 (d): a confident per-muscle growth claim needs 2-3 exercises for that
 * muscle to agree, so a pair drawn from one exercise never carries it alone.
 *
 * The weakest recorded side governs — a claim leaning on this pair is only as
 * corroborated as its worse-supported end — and both sides' raw counts are
 * quoted so a caller can see which end is thin.
 */
function corroborationNote(a: ComparabilitySubject, b: ComparabilitySubject): string {
  const { min, max } = CORROBORATING_EXERCISES;
  const sides = `${numberLabel(a.corroboratingExerciseCount)} vs ${numberLabel(b.corroboratingExerciseCount)}`;
  const counts = [a.corroboratingExerciseCount, b.corroboratingExerciseCount].filter(
    (count): count is number => count !== undefined,
  );
  if (counts.length === 0) {
    return (
      "neither set records how many exercises for the same muscle back it, so B16 (d)'s " +
      `${min}-${max} exercise corroboration is unchecked and a per-muscle growth claim on this ` +
      'pair is uncorroborated'
    );
  }
  const weakest = Math.min(...counts);
  if (weakest < min) {
    return (
      `${corroborationLabel(weakest)} for this muscle (${sides}), below B16 (d)'s ${min}-${max}, ` +
      'so a confident per-muscle growth claim is withheld until another exercise agrees'
    );
  }
  return `${corroborationLabel(weakest)} for this muscle (${sides}) meets B16 (d)'s ${min}-${max} gate`;
}

/**
 * B16 (f): inside the neural window a strength gain does not support a
 * muscle-gain claim, and the lifter is told that in words rather than refused.
 *
 * The youngest recorded side governs: a claim spanning the pair is only as old
 * as its newer end. A one-sided absence does NOT block here, unlike the context
 * clauses — this clause never blocks at all — and a recorded side that clears
 * the window still says the other end is unknown.
 */
function trainingAgeNote(a: ComparabilitySubject, b: ComparabilitySubject): string {
  const { min, max } = NEURAL_GAIN_WINDOW_MONTHS;
  const sides = `${numberLabel(a.trackedTrainingMonths)} vs ${numberLabel(b.trackedTrainingMonths)}`;
  const months = [a.trackedTrainingMonths, b.trackedTrainingMonths].filter(
    (value): value is number => value !== undefined,
  );
  if (months.length === 0) {
    return (
      `neither set records how many months of training are tracked behind it, so B16 (f)'s ` +
      `${min}-${max} month neural-gain window is unchecked and a muscle-gain claim on this pair ` +
      'is unqualified'
    );
  }
  const youngest = Math.min(...months);
  if (youngest < max) {
    return `${EARLY_TRAINING_STRENGTH_WORDING} (tracked training in months: ${sides})`;
  }
  return (
    `${youngest} months of tracked training is past B16 (f)'s ${min}-${max} month neural-gain ` +
    `window (${sides}), so a strength gain here may be read as muscle gained`
  );
}

function corroborationLabel(count: number): string {
  return `${count} corroborating exercise${count === 1 ? '' : 's'}`;
}

/**
 * The shared clause shape for a value that must match: equal (including
 * absent-on-both) passes, one-sided absence blocks because an unrecorded value
 * is not evidence of a match, and a real difference blocks.
 */
function matchOrExplain(a: string | undefined, b: string | undefined, what: string): ClauseResult {
  if (a === undefined && b === undefined) {
    return bothAbsent(`neither set records a ${what}, so this clause passes unchecked`);
  }
  if (a === undefined || b === undefined) {
    return { ok: false, reason: `${what} recorded on only one side (${label(a)} vs ${label(b)})` };
  }
  return a === b ? OK : { ok: false, reason: `different ${what} (${a} vs ${b})` };
}

function loadClause(a: ComparabilitySubject, b: ComparabilitySubject): ClauseResult {
  if (a.weightLbs === undefined && b.weightLbs === undefined) {
    return bothAbsent('neither set records a header weight, so the load clause passes unchecked');
  }
  if (a.weightLbs === undefined || b.weightLbs === undefined) {
    return { ok: false, reason: 'load recorded on only one side' };
  }
  if (loadsMatch(a.weightLbs, b.weightLbs)) return OK;
  return {
    ok: false,
    reason:
      `different load (${a.weightLbs} vs ${b.weightLbs} lb)` +
      (LOAD_TOLERANCE_PCT === null
        ? ' — no load tolerance is sourced, so loads must match exactly'
        : ''),
  };
}

function loadsMatch(a: number, b: number): boolean {
  if (LOAD_TOLERANCE_PCT === null) return a === b;
  const basis = Math.max(Math.abs(a), Math.abs(b));
  if (basis === 0) return true;
  return (Math.abs(a - b) / basis) * 100 <= LOAD_TOLERANCE_PCT;
}

function label(value: string | undefined): string {
  return value ?? 'unrecorded';
}

function numberLabel(value: number | undefined): string {
  return value === undefined ? 'unrecorded' : String(value);
}

function lifterLabel(subject: ComparabilitySubject): string {
  return subject.lifter ?? 'owner';
}

/** One end of a comparison, named so a caller can show which set was used. */
export interface ComparabilityPartner {
  setId: string;
  reasons: string[];
}

/**
 * What a consumer reports. Exactly one of `comparedTo` / `noValidComparison` is
 * present; `nearest` accompanies the refusal so the answer is never silence.
 */
export interface ComparabilityReport {
  comparedTo?: ComparabilityPartner;
  noValidComparison?: true;
  nearest?: ComparabilityPartner;
}

/**
 * Pick the set to compare `target` against.
 *
 * Candidates are judged in the order given and the FIRST comparable one wins,
 * so the caller's ordering is the tie-break it wants (session order for a
 * readiness anchor, newest-first for a progression basis).
 *
 * With none comparable the nearest candidate is still named: fewest blocking
 * reasons first, then the closest load, then the caller's order. An engine that
 * goes quiet on an irregular lifter is a product failure even when it is
 * technically correct, so "no pair" still answers with a set and a why.
 */
export function chooseComparisonPartner(
  target: ComparabilitySubject,
  candidates: readonly ComparabilitySubject[],
): ComparabilityReport {
  const judged = candidates
    .filter((candidate) => candidate.id !== target.id)
    .map((candidate) => ({ candidate, verdict: isComparable(target, candidate) }));

  const match = judged.find((entry) => entry.verdict.comparable);
  if (match !== undefined) {
    return { comparedTo: { setId: match.candidate.id, reasons: match.verdict.reasons } };
  }
  const nearest = nearestOf(target, judged);
  if (nearest === undefined) return { noValidComparison: true };
  return {
    noValidComparison: true,
    nearest: { setId: nearest.candidate.id, reasons: nearest.verdict.reasons },
  };
}

interface JudgedCandidate {
  candidate: ComparabilitySubject;
  verdict: ComparabilityVerdict;
}

function nearestOf(
  target: ComparabilitySubject,
  judged: readonly JudgedCandidate[],
): JudgedCandidate | undefined {
  let best: JudgedCandidate | undefined;
  for (const entry of judged) {
    if (best === undefined || rank(target, entry) < rank(target, best)) best = entry;
  }
  return best;
}

/** Lower is nearer: blocking-reason count dominates, load distance breaks ties. */
function rank(target: ComparabilitySubject, entry: JudgedCandidate): number {
  const blockers = entry.verdict.reasons.filter((r) => !r.includes(' (note): ')).length;
  return blockers * 1e6 + loadDistance(target.weightLbs, entry.candidate.weightLbs);
}

/** An unrecorded load on either side sorts behind every measurable distance. */
function loadDistance(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return 1e5;
  return Math.min(Math.abs(a - b), 1e5 - 1);
}
