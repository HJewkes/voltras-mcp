// Like-vs-like comparability predicate — v1 of B16 (VW-94).
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
// Two clauses (training phase, physical setup) have no writer on this schema —
// the phase tag is a pending human decision (B34 / VW-149) and `setupId` is
// being built separately. Absent on BOTH sides passes with a note rather than
// blocking, per the backlog's own instruction to degrade rather than refuse.
// The predicate says what it could not check instead of pretending it checked.
//
// Strict matching also means few valid pairs for an irregular lifter, so no
// consumer of this module may answer with silence: `chooseComparisonPartner`
// always names the nearest candidate and the reasons it failed.
//
// OUT OF SCOPE FOR v1: B16's clauses (b) whole-profile comparison, (d)
// multi-exercise corroboration, (e) exercise-swap reframing and (f) the
// early-training strength-to-hypertrophy suppression. (f) in particular is a
// wording problem before it is a math problem — a beginner who IS getting
// stronger must not read its output as "you are not progressing" — and its copy
// belongs with the surface that makes the muscle-gain claim, not here.

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
 * A set as far as comparability is concerned. Structural, so a `StoredSet`
 * passes without conversion.
 *
 * `setupId` and `phase` have NO WRITER on this schema (see the header). They
 * are declared because the clauses that read them are part of v1 and must
 * degrade visibly rather than be silently missing from the predicate.
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
  /** Inferred physical configuration. No writer yet (w3-31 is building one). */
  setupId?: string | undefined;
  /** Training-phase tag: fat-loss / gain / maintenance. No writer yet (B34). */
  phase?: string | undefined;
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

const OK: ClauseResult = { ok: true };

/** Both sides absent — the degrade case the backlog asks for, kept as a note. */
function bothAbsent(note: string): ClauseResult {
  return { ok: true, note };
}

/**
 * Clause order is the backlog's own: exercise, lifter, purpose, training mode,
 * device settings, side, load, then the two clauses that have no writer yet.
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
];

/**
 * Is this pair like-vs-like? Pure: no store read, no rep math, no clock.
 *
 * Every clause is evaluated — the predicate does not short-circuit — because a
 * caller showing a user why a comparison failed needs the whole list, not the
 * first blocker.
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
  return { comparable, reasons };
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
