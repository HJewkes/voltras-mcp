// A lint pass over rendered coach copy: the mechanical half of the copy rules
// in `sources/notes/2026-09-12-accountability-system-plan.md` §2 (VW-287).
// Every composer test runs it over every message it renders, so a template edit
// that breaks a rule fails the suite rather than shipping.
//
// It reads rendered TEXT, not the composer's internals, and it asserts rules
// rather than prose: an editor is free to rewrite any sentence as long as the
// rewrite still obeys them. Where a rule is not mechanisable (rule 1's "never
// about the person" in full generality), this checks the strongest proxy it can
// and the rest stays a review question.

import { NON_JUDGMENT_LINE, OPERATIONAL_HONESTY_LINE } from '../copy.js';

/** Rule 6: answers run a little past what was asked, never one word and never an essay. */
const MIN_CHARS = 80;
const MAX_CHARS = 1400;

/** Rule 2: no running total, no cumulative framing, no "that's the third this month". */
const BANNED_CUMULATIVE = [
  /\bagain\b/i,
  /\bthis month\b/i,
  /\bthird\b/i,
  /\bso far\b/i,
  /\brunning total\b/i,
  /\bcumulative\b/i,
  /\bthat makes \d+\b/i,
  /\bfor the \w+ time\b/i,
  /\bevery time\b/i,
];

/** Rule 5: no streak, because a streak ships a zero state with it (LIT §3.8). */
const BANNED_STREAK = [
  /\bstreak\b/i,
  /\bin a row\b/i,
  /\bconsecutive\b/i,
  /\bunbroken\b/i,
  /\bchain\b/i,
];

/** Rule 2: every message is standalone, so none may lean on an earlier one. */
const BANNED_BACK_REFERENCE = [
  /\bmy (last|previous|earlier) (message|note|text)\b/i,
  /\bas I (said|mentioned|noted)\b/i,
  /\bfollowing up\b/i,
  /\bcircling back\b/i,
  /\bchecking in\b/i,
  /\bbumping\b/i,
  /\breminder\b/i,
  /\bsecond (message|attempt)\b/i,
  /\bare you (alive|there|ok|okay)\b/i,
  /\bhaven'?t heard\b/i,
  /\bno (response|reply)\b/i,
  /\bstill waiting\b/i,
];

/** Rule 1: the message is about the session, never a read on the person. */
const BANNED_JUDGMENT = [
  /\blaz(y|iness)\b/i,
  /\bslack(ing|ed|er)\b/i,
  /\bexcuses?\b/i,
  /\bunacceptable\b/i,
  /\bdisappoint(ing|ed|ment)\b/i,
  /\bfail(ed|ure|ing)?\b/i,
  /\bsloppy\b/i,
  /\bdiscipline\b/i,
  /\bwillpower\b/i,
  /\bshould have\b/i,
  /\bshame(ful)?\b/i,
  /\bnot serious\b/i,
];

/** Rule 1: a negative observation without a next action is the shame appeal the rule bans. */
const NEGATIVE_OBSERVATION = [
  /\bnot in the records\b/i,
  /\bunrecorded\b/i,
  /\bworsening\b/i,
  /\bmiss(ed|es)?\b/i,
  /\bskipped\b/i,
  /\bno session\b/i,
  /\bnothing recorded\b/i,
  /\bslipping\b/i,
  /\bfalling behind\b/i,
  /\bkeeps breaking\b/i,
];

const DAY_OR_DURATION =
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|today|tomorrow|\d+ minutes)\b/i;

const ACTION_VERB =
  /\b(run|runs|send|sends|reply|book|books|booked|schedules?|scheduled|set up|put|puts|keep|keeps|hold|holds|held|move|moves|moving|start|starts|pick|say|tell|restate|rebuild|counts as)\b/i;

/** Rule 6: a prescription with no rationale is the "just trust me" the corpus bans. */
const PRESCRIPTIVE_LEAD =
  /^(keep|send|reply|pick|say|tell|name|run|start|put|hold|do|cut|add|book|take|try|use|set|move|rebuild|restate|schedule|go)\b/i;

const LETS = /\blet'?s\b/i;

const RATIONALE =
  /\bbecause\b|\bso that\b|\bsince\b|\bthat way\b|\bwhich (is why|keeps|lets|means)\b|\bthe reason\b/i;

/** Rule 4: a frequency offer re-architects within the same number of days, never below it. */
const RE_ARCHITECT = /\bre-architect(ing|ed)?\b/i;
const WITHIN_N_DAYS = /\bwithin (the same )?(one|two|three|four|five|six|seven|\d+) days\b/i;
const BANNED_REDUCTION = [
  /\bquit(ting)?\b/i,
  /\bgive up\b/i,
  /\bfewer days\b/i,
  /\b(drop|cut|lose) (a|one) day\b/i,
  /\bstop training\b/i,
];

function fail(rule: string, detail: string, text: string): never {
  throw new Error(`copy rule violated (${rule}): ${detail}\n---\n${text}\n---`);
}

function sentences(text: string): string[] {
  return text
    .split('\n')
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

function assertNoneMatch(text: string, patterns: readonly RegExp[], rule: string): void {
  for (const pattern of patterns) {
    const hit = pattern.exec(text);
    if (hit !== null) fail(rule, `banned phrase "${hit[0]}"`, text);
  }
}

/** Rule 3: the non-judgment line first, then the operational reason. Reversed, it reads as an accusation. */
function assertHonestyOrder(text: string): void {
  const honesty = text.indexOf(OPERATIONAL_HONESTY_LINE);
  if (honesty === -1) return;
  const nonJudgment = text.indexOf(NON_JUDGMENT_LINE);
  if (nonJudgment === -1) {
    fail('rule 3', 'the operational-honesty line appears with no non-judgment line', text);
  }
  if (nonJudgment > honesty) {
    fail('rule 3', 'the non-judgment line must precede the operational-honesty line', text);
  }
}

function assertNegativeObservationIsPaired(text: string): void {
  const negative = NEGATIVE_OBSERVATION.find((pattern) => pattern.test(text));
  if (negative === undefined) return;
  const hasAction = sentences(text).some(
    (sentence) => DAY_OR_DURATION.test(sentence) && ACTION_VERB.test(sentence),
  );
  if (!hasAction) {
    fail(
      'rule 1',
      `a negative observation (${negative.source}) carries no dated concrete next action`,
      text,
    );
  }
}

function assertPrescriptionsCarryRationale(text: string): void {
  for (const sentence of sentences(text)) {
    const prescriptive = PRESCRIPTIVE_LEAD.test(sentence) || LETS.test(sentence);
    if (prescriptive && !RATIONALE.test(sentence)) {
      fail('rule 6', `prescriptive sentence with no rationale clause: "${sentence}"`, text);
    }
  }
}

function assertFrequencyOfferIsReArchitecture(text: string): void {
  assertNoneMatch(text, BANNED_REDUCTION, 'rule 4');
  if (!RE_ARCHITECT.test(text)) return;
  if (!WITHIN_N_DAYS.test(text)) {
    fail('rule 4', 're-architecting offer does not state a "within N days" bound', text);
  }
}

function assertLength(text: string): void {
  if (text.length < MIN_CHARS) fail('rule 6', `message is too terse (${text.length} chars)`, text);
  if (text.length > MAX_CHARS) fail('rule 6', `message is an essay (${text.length} chars)`, text);
  if (sentences(text).length < 2) fail('rule 6', 'message is a single sentence', text);
}

/**
 * Throws on the first violated rule. Every composer test calls this over every
 * message it renders; the message-specific rules (the Sunday anchor's show-back,
 * the miss-recovery prompt's single offer) live with those tests.
 */
export function assertCopyRules(text: string): void {
  assertNoneMatch(text, BANNED_CUMULATIVE, 'rule 2');
  assertNoneMatch(text, BANNED_STREAK, 'rule 5');
  assertNoneMatch(text, BANNED_BACK_REFERENCE, 'rule 2');
  assertNoneMatch(text, BANNED_JUDGMENT, 'rule 1');
  assertHonestyOrder(text);
  assertNegativeObservationIsPaired(text);
  assertPrescriptionsCarryRationale(text);
  assertFrequencyOfferIsReArchitecture(text);
  assertLength(text);
}
