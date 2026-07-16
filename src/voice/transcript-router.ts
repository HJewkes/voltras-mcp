// Pure transcript classifier for the VAD+whisper listener (VMCP-02.77 P3).
//
// Splits a whisper transcript into three routing tiers so the listener can act:
//   - 'safety'  emergency stop phrases (ungated by wake; wired to unload in .78)
//   - 'wake'    the user addressed the coach -> forward the stripped command
//   - 'ignore'  ambient speech -> drop
// No deps, no I/O: classification is a function of the string alone.

export type TranscriptTier = 'safety' | 'wake' | 'ignore';

export interface RouteResult {
  tier: TranscriptTier;
  matchedPhrase?: string; // set when tier==='safety' — which safety phrase matched
  commandText?: string; // set when tier==='wake' — transcript with the wake phrase stripped
}

export const SAFETY_PHRASES: readonly string[] = [
  'stop',
  'unload',
  'cut the weight',
  'drop it',
  'let go',
  'release',
  'kill it',
  'abort',
];

// Tokens that flip a safety keyword into ordinary speech when they sit directly
// in front of it ("don't stop", "no need to stop"). Multi-word tokens included.
const NEGATION_TOKENS: readonly string[] = [
  "don't",
  'do not',
  'dont',
  'keep',
  'never',
  'no need to',
];

const DEFAULT_WAKE_PHRASES: readonly string[] = ['hey coach'];

// Nominal cap is 6 words (plan §P3). We require STRICTLY fewer than 6 so a
// 6-word conversational sentence ("we can stop after this set") routes as speech
// rather than an emergency; genuine shouts ("stop", "cut the weight") stay in.
const MAX_SAFETY_WORDS = 6;

const LEADING_PUNCT = /^[^\p{L}\p{N}]+/u;
const TRAILING_PUNCT = /[^\p{L}\p{N}]+$/u;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-word / whole-phrase match: \b keeps "stop" out of "nonstop"/"stopwatch".
function phraseRegex(phrase: string): RegExp {
  return new RegExp(`\\b${escapeRegex(phrase)}\\b`);
}

function stripSurroundingPunct(text: string): string {
  return text.replace(LEADING_PUNCT, '').replace(TRAILING_PUNCT, '');
}

function normalize(text: string): string {
  const collapsed = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return stripSurroundingPunct(collapsed);
}

function wordCount(normalized: string): number {
  return normalized === '' ? 0 : normalized.split(' ').length;
}

// A negation token counts only when it sits immediately before the keyword.
function isNegated(text: string, matchStart: number): boolean {
  const before = text.slice(0, matchStart).trimEnd();
  return NEGATION_TOKENS.some((token) => before === token || before.endsWith(` ${token}`));
}

function findSafetyPhrase(text: string): string | undefined {
  for (const phrase of SAFETY_PHRASES) {
    const match = phraseRegex(phrase).exec(text);
    if (match && !isNegated(text, match.index)) return phrase;
  }
  return undefined;
}

function matchWake(text: string, phrase: string): RouteResult | undefined {
  const match = phraseRegex(phrase).exec(text);
  if (!match) return undefined;
  const remainder = text.slice(0, match.index) + text.slice(match.index + phrase.length);
  return { tier: 'wake', commandText: normalize(remainder) };
}

function findWake(text: string, wakePhrases: readonly string[]): RouteResult | undefined {
  for (const phrase of wakePhrases) {
    const result = matchWake(text, normalize(phrase));
    if (result) return result;
  }
  return undefined;
}

export function routeTranscript(
  transcript: string,
  opts?: { wakePhrases?: string[] },
): RouteResult {
  const text = normalize(transcript);
  if (text === '') return { tier: 'ignore' };

  const safety = findSafetyPhrase(text);
  if (safety !== undefined && wordCount(text) < MAX_SAFETY_WORDS) {
    return { tier: 'safety', matchedPhrase: safety };
  }

  const wakePhrases = opts?.wakePhrases ?? DEFAULT_WAKE_PHRASES;
  return findWake(text, wakePhrases) ?? { tier: 'ignore' };
}
