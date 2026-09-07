// Pure parser for spoken weight commands (VMCP-02.87).
//
// The listener's Tier-A safety path proved that acting locally beats waiting on
// a model turn. This is the same idea for the command the athlete gives most:
// changing the load. `parseWeightCommand` turns a whisper transcript into an
// intent (absolute / relative / undo) or `null` for "not a command" — no I/O,
// no device knowledge. Range checks and slot resolution belong to the caller.
//
// Whisper output is lowercase-ish, filler-laden and comma-spattered
// ("to like, , set it to 70"), so the parser tokenizes and screens rather than
// pattern-matching whole strings.

export type WeightCommandSlot = 'left' | 'right';

export type WeightCommand =
  | { kind: 'absolute'; lbs: number; slot?: WeightCommandSlot }
  | { kind: 'relative'; deltaLbs: number; slot?: WeightCommandSlot }
  | { kind: 'undo'; slot?: WeightCommandSlot };

/** Step applied by a bare "lighter" / "heavier" with no number. */
export const DEFAULT_STEP_LBS = 5;

/**
 * Word cap after filler removal. Same instinct as the safety tier's cap: a
 * command is short and imperative, conversation is not. Every supported cue
 * fits in six words ("to set it to 70" is five).
 */
const MAX_COMMAND_WORDS = 6;

/**
 * A bare number with no verb or preposition ("seventy") is a command, but only
 * above the band an athlete counts reps in — "five" during a set must never
 * become a 5 lb write.
 */
const MIN_BARE_NUMBER = 20;

const FILLER = new Set([
  'like',
  'uh',
  'um',
  'er',
  'ah',
  'okay',
  'ok',
  'please',
  'just',
  'yeah',
  'hey',
  'coach',
  'now',
  'gonna',
]);

const UNDO_PHRASES = new Set([
  'cancel',
  'cancel that',
  'never mind',
  'nevermind',
  'undo',
  'undo that',
  'scratch that',
]);

const UP_WORDS = new Set(['up', 'add', 'bump', 'increase', 'raise', 'more', 'heavier', 'higher']);
const DOWN_WORDS = new Set([
  'down',
  'drop',
  'lower',
  'decrease',
  'less',
  'lighter',
  'off',
  'subtract',
  'reduce',
]);

/** Words that make the number a target rather than a delta ("go to 65"). */
const TARGET_PREPOSITIONS = new Set(['to', 'at']);
const TARGET_VERBS = new Set(['set', 'make', 'put', 'go', 'weight', 'move', 'bring']);
const WEIGHT_UNITS = new Set(['pounds', 'pound', 'lbs', 'lb']);

// A command is imperative and present-tense. Anything reporting, asking or
// hypothesizing about weight is conversation the model should answer instead.
const CONVERSATIONAL = new Set([
  'how',
  'what',
  'why',
  'when',
  'whether',
  'should',
  'would',
  'think',
  'thought',
  'feel',
  'felt',
  'was',
  'were',
  'did',
  'does',
  'do',
  'maybe',
  'last',
  'about',
  'time',
]);

const NEGATIONS = new Set([
  "don't",
  'dont',
  'not',
  'never',
  'no',
  "didn't",
  "won't",
  "can't",
  'keep',
]);

const ONES: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fourty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

interface NumberRun {
  value: number;
  start: number;
  end: number; // exclusive
}

function tokenize(text: string): string[] {
  const words =
    text
      .toLowerCase()
      .replace(/-/g, ' ')
      .match(/[a-z0-9']+/g) ?? [];
  return words.filter((word) => !FILLER.has(word));
}

function isNumberWord(token: string): boolean {
  return /^\d+$/.test(token) || token in ONES || token in TENS || token === 'hundred';
}

/**
 * Fold a run of number tokens into one value. Handles "seventy five" (75),
 * "one thirty" (130 — a ones digit in front of a tens word is spoken shorthand
 * for hundreds, not addition) and "a hundred and ten" (110).
 */
function readNumberRun(tokens: string[], start: number): NumberRun | null {
  let value = 0;
  let seen = false;
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === 'a' && tokens[index + 1] === 'hundred') {
      value += 1;
    } else if (token === 'and' && seen && isNumberWord(tokens[index + 1] ?? '')) {
      // separator only
    } else if (token === 'hundred') {
      value = (value === 0 ? 1 : value) * 100;
      seen = true;
    } else if (/^\d+$/.test(token)) {
      if (seen) break;
      value = Number(token);
      seen = true;
    } else if (token in TENS) {
      value = value >= 1 && value <= 9 ? value * 100 + TENS[token] : value + TENS[token];
      seen = true;
    } else if (token in ONES) {
      if (seen && value % 10 !== 0) break;
      value += ONES[token];
      seen = true;
    } else {
      break;
    }
    index += 1;
  }
  return seen ? { value, start, end: index } : null;
}

function findNumber(tokens: string[]): NumberRun | null {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === 'a' || isNumberWord(tokens[i])) {
      const run = readNumberRun(tokens, i);
      if (run !== null) return run;
    }
  }
  return null;
}

function findSlot(tokens: string[]): WeightCommandSlot | undefined {
  if (tokens.includes('left')) return 'left';
  if (tokens.includes('right')) return 'right';
  return undefined;
}

function withSlot(command: WeightCommand, slot: WeightCommandSlot | undefined): WeightCommand {
  return slot === undefined ? command : { ...command, slot };
}

function parseUndo(tokens: string[]): WeightCommand | null {
  const slot = findSlot(tokens);
  const words = tokens.filter((token) => token !== 'left' && token !== 'right');
  if (words.length === 0 || words.length > 3) return null;
  const joined = words.join(' ');
  if (!UNDO_PHRASES.has(joined)) return null;
  return withSlot({ kind: 'undo' }, slot);
}

function direction(tokens: string[], before: number): 1 | -1 | null {
  for (let i = 0; i < before; i += 1) {
    if (UP_WORDS.has(tokens[i])) return 1;
    if (DOWN_WORDS.has(tokens[i])) return -1;
  }
  return null;
}

/**
 * A preposition in front of the number (or a unit behind it) makes the number a
 * target even when a direction word came earlier: "go up to 100" is absolute,
 * "go up ten" is not. This adjacency is the only thing that outranks direction.
 */
function isTargetedByAdjacency(tokens: string[], run: NumberRun): boolean {
  const previous = run.start > 0 ? tokens[run.start - 1] : '';
  const next = tokens[run.end] ?? '';
  return TARGET_PREPOSITIONS.has(previous) || WEIGHT_UNITS.has(next);
}

function hasTargetVerb(tokens: string[], run: NumberRun): boolean {
  return tokens.slice(0, run.start).some((token) => TARGET_VERBS.has(token));
}

function isBareNumber(tokens: string[], run: NumberRun): boolean {
  return tokens.every(
    (token, index) =>
      (index >= run.start && index < run.end) || token === 'left' || token === 'right',
  );
}

function parseStep(tokens: string[]): WeightCommand | null {
  if (tokens.includes('lighter')) return { kind: 'relative', deltaLbs: -DEFAULT_STEP_LBS };
  if (tokens.includes('heavier')) return { kind: 'relative', deltaLbs: DEFAULT_STEP_LBS };
  return null;
}

/** A spelled-out number is one spoken quantity, not four words of sentence. */
function spokenWordCount(tokens: string[], run: NumberRun | null): number {
  return run === null ? tokens.length : tokens.length - (run.end - run.start) + 1;
}

function screened(tokens: string[]): boolean {
  return tokens.some((token) => CONVERSATIONAL.has(token) || NEGATIONS.has(token));
}

/**
 * Classify a transcript as a weight command, or `null` when it is anything
 * else. Callers must still range-check (`lbs`) and resolve the target slot;
 * an omitted `slot` means "the parser heard no side word".
 */
export function parseWeightCommand(transcript: string): WeightCommand | null {
  const tokens = tokenize(transcript);
  const undo = parseUndo(tokens);
  if (undo !== null) return undo;
  if (tokens.length === 0) return null;
  if (transcript.includes('?') || screened(tokens)) return null;
  const slot = findSlot(tokens);
  const run = findNumber(tokens);
  if (spokenWordCount(tokens, run) > MAX_COMMAND_WORDS) return null;
  if (run === null) {
    const step = parseStep(tokens);
    return step === null ? null : withSlot(step, slot);
  }
  const targeted = isTargetedByAdjacency(tokens, run);
  const sign = targeted ? null : direction(tokens, run.start);
  if (sign !== null) return withSlot({ kind: 'relative', deltaLbs: sign * run.value }, slot);
  if (targeted || hasTargetVerb(tokens, run)) {
    return withSlot({ kind: 'absolute', lbs: run.value }, slot);
  }
  if (isBareNumber(tokens, run) && run.value >= MIN_BARE_NUMBER) {
    return withSlot({ kind: 'absolute', lbs: run.value }, slot);
  }
  return null;
}
