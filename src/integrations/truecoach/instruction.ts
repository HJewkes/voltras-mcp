// Conservative parser for a TrueCoach instruction string.
//
// The instruction is freeform text a human coach typed (`50lbs x AMRAP x 4
// sets`, `3 sets of 8-10 @ 135lb, rest 90s`). There is no schema and never was
// one, so this parser is deliberately narrow: it recognises a fixed list of
// idioms and leaves every field it cannot read ABSENT. It never guesses.
//
// The verbatim instruction is always kept in `notes` by the caller, so an
// unparsed field costs the model a lookup, not the information.

/**
 * Targets read out of one instruction. Every numeric field is
 * `number | undefined` rather than optional so `exactOptionalPropertyTypes`
 * callers can spread the object without a conditional per field.
 */
export interface ParsedTargets {
  readonly targetSets: number | undefined;
  readonly targetRepsLow: number | undefined;
  readonly targetRepsHigh: number | undefined;
  readonly targetWeightLbs: number | undefined;
  readonly restSec: number | undefined;
  /** True when the instruction says AMRAP: the rep target is open-ended by design. */
  readonly amrap: boolean;
}

const EMPTY: ParsedTargets = {
  targetSets: undefined,
  targetRepsLow: undefined,
  targetRepsHigh: undefined,
  targetWeightLbs: undefined,
  restSec: undefined,
  amrap: false,
};

const AMRAP = /\bAMRAP\b/i;
/** `50lbs x AMRAP x 4 sets` / `3 x 8` / `3 x 8-10` — the set count leads. */
const SETS_BY_REPS = /(?<![\d.])(\d{1,2})\s*[x×]\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?(?![\d.])/;
/** `3 sets of 8` / `3 sets of 8-10`. */
const SETS_OF_REPS = /(?<![\d.])(\d{1,2})\s*sets?\s+of\s+(\d{1,3})(?:\s*-\s*(\d{1,3}))?(?![\d.])/i;
/** `135 x 8 x 3 sets` — the weight leads and the set count trails the word "sets". */
const WEIGHT_REPS_SETS =
  /(?<![\d.])(\d{1,4}(?:\.\d+)?)\s*(?:lbs?\.?)?\s*[x×]\s*(\d{1,3})\s*[x×]\s*(\d{1,2})\s*sets?\b/i;
/** A bare set count, for instructions that give no rep target (`AMRAP x 4 sets`). */
const BARE_SETS = /(?<![\d.])(\d{1,2})\s*sets?\b/i;
/** `@ 135 lb` and the bare `50lbs` prefix idiom. */
const WEIGHT_AT = /@\s*(\d{1,4}(?:\.\d+)?)\s*lbs?\.?\b/i;
const WEIGHT_BARE = /(?<![\d.])(\d{1,4}(?:\.\d+)?)\s*lbs?\.?\b/i;
/** `rest 90s`, `rest: 2 min`. */
const REST_LABELLED = /\brest\s*[:-]?\s*(\d{1,4})\s*(s|sec|secs|seconds|m|min|mins|minutes)\b/i;
/**
 * A standalone duration with no `rest` label. Only two-or-more-digit seconds
 * and single/double-digit minutes qualify, and only when the token is not part
 * of a `x`-joined prescription — `3 x 8` must never read as 8 minutes.
 */
const REST_BARE = /(?:^|[\s,;(])(\d{2,4})\s*(s|sec|secs|seconds)\b/i;
const REST_BARE_MIN = /(?:^|[\s,;(])(\d{1,2})\s*(m|min|mins|minutes)\b/i;

const SECONDS_PER_MINUTE = 60;

/** Parse `text` into targets. Returns all-absent for empty or unrecognised text. */
export function parseInstruction(text: string | undefined): ParsedTargets {
  if (text === undefined || text.trim() === '') return EMPTY;
  const amrap = AMRAP.test(text);
  const { sets, repsLow, repsHigh, weight } = parseVolume(text, amrap);
  return {
    targetSets: sets,
    targetRepsLow: repsLow,
    targetRepsHigh: repsHigh,
    targetWeightLbs: weight ?? parseWeight(text),
    restSec: parseRest(text),
    amrap,
  };
}

interface Volume {
  sets: number | undefined;
  repsLow: number | undefined;
  repsHigh: number | undefined;
  /** Only the `W x R x N sets` idiom carries a load with no `lb` suffix to find it by. */
  weight: number | undefined;
}

/**
 * Sets and reps. AMRAP short-circuits the rep target: the whole point of the
 * idiom is that there isn't one, so only the set count is read and both rep
 * bounds stay absent (the word itself survives in `notes`).
 */
function parseVolume(text: string, amrap: boolean): Volume {
  if (amrap) return bareSets(text);
  const weightFirst = WEIGHT_REPS_SETS.exec(text);
  if (weightFirst !== null) {
    return {
      sets: toInt(weightFirst[3]),
      repsLow: toInt(weightFirst[2]),
      repsHigh: undefined,
      weight: toFloat(weightFirst[1]),
    };
  }
  const setsFirst = SETS_OF_REPS.exec(text) ?? SETS_BY_REPS.exec(text);
  if (setsFirst !== null) {
    return {
      sets: toInt(setsFirst[1]),
      repsLow: toInt(setsFirst[2]),
      repsHigh: toInt(setsFirst[3]),
      weight: undefined,
    };
  }
  return bareSets(text);
}

function bareSets(text: string): Volume {
  return {
    sets: matchInt(text, BARE_SETS, 1),
    repsLow: undefined,
    repsHigh: undefined,
    weight: undefined,
  };
}

/**
 * Load in pounds. `@ 135 lb` first because it is unambiguous; the bare
 * `50lbs` prefix only applies when no `x`-joined triple already claimed it,
 * which `parseVolume` handles independently.
 */
function parseWeight(text: string): number | undefined {
  const at = WEIGHT_AT.exec(text);
  if (at !== null) return toFloat(at[1]);
  const bare = WEIGHT_BARE.exec(text);
  return bare === null ? undefined : toFloat(bare[1]);
}

/** Rest in seconds. Minutes are converted; anything else stays absent. */
function parseRest(text: string): number | undefined {
  const labelled = REST_LABELLED.exec(text);
  if (labelled !== null) return toSeconds(labelled[1], labelled[2]);
  const bareSec = REST_BARE.exec(text);
  if (bareSec !== null) return toSeconds(bareSec[1], bareSec[2]);
  const bareMin = REST_BARE_MIN.exec(text);
  return bareMin === null ? undefined : toSeconds(bareMin[1], bareMin[2]);
}

function toSeconds(value: string | undefined, unit: string | undefined): number | undefined {
  const n = toInt(value);
  if (n === undefined || unit === undefined) return undefined;
  return unit.toLowerCase().startsWith('m') ? n * SECONDS_PER_MINUTE : n;
}

function matchInt(text: string, pattern: RegExp, group: number): number | undefined {
  const match = pattern.exec(text);
  return match === null ? undefined : toInt(match[group]);
}

function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function toFloat(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
