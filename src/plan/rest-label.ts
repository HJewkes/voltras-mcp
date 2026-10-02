// Rest-pause is a set technique, whatever separates the two words.
const REST_WORD = /\brest\b(?![\s\-–—/,]*pause)/i;
// "Back-off" sets and "Off-season" phases are training labels, not days off.
const OFF_WORD = /(?<!\bback[\s-]*)\boff\b(?![\s-]*season)/i;
const OFF_ONLY = /^(off|day off|off day)$/i;

/** "Rest", "Active rest" and "Rest day" read as rest; "Rest-pause" in any spelling does not. */
export function hasRestWord(text: string): boolean {
  return REST_WORD.test(text);
}

/** "off" as a word anywhere in the label, except "Back-off" and "Off-season". */
export function hasOffWord(text: string): boolean {
  return OFF_WORD.test(text);
}

/** A label that is exactly "off", "day off" or "off day". */
export function isOffOnly(text: string): boolean {
  return OFF_ONLY.test(text.trim());
}
