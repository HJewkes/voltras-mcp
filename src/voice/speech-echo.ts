// Self-echo detector for the muted-window safety path (VMCP-05.20).
//
// While a TTS cue plays, the listener keeps transcribing so a shouted safety
// phrase is still heard (see voice-listener.ts). The cost of that is whisper
// transcribing the machine's OWN voice, which is exactly the self-trigger loop
// the mute existed to prevent. We can close it because the spoken text is
// known: `speak()` hands it to `mute()`, and any muted-window transcript that
// is mostly words from what is being said aloud is treated as echo and dropped
// before routing.
//
// Deliberately word-set based, not exact-match: whisper hears a fragment of the
// cue ("percent slower reset"), not the rendered template, and it may reorder,
// drop punctuation, or mangle numbers. Token coverage survives all three.
//
// Residual risk this CANNOT solve: a lifter shouting a safety word that also
// appears in the cue being spoken ("don't stop now" + "stop") is indistinguish-
// able from echo and is dropped. That is a deliberate trade — a false unload
// from our own audio is worse than a missed stop that the lifter can repeat a
// second later, once the cue ends. No cue template in CUE_CATALOG contains a
// safety word today; `cue-templates.test.ts` is where that stays true.

/**
 * Fraction of a transcript's words that must appear in the spoken text before
 * it counts as echo. Below 1.0 so a fragment padded with a whisper hallucin-
 * ation ("uh", "thanks") still matches; high enough that a short genuine
 * utterance ("stop") does not match an unrelated cue.
 */
const ECHO_COVERAGE = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '');
}

function coverage(heard: readonly string[], spoken: ReadonlySet<string>): number {
  const covered = heard.filter((word) => spoken.has(word)).length;
  return covered / heard.length;
}

/**
 * Whether `transcript` is plausibly the machine hearing itself say one of
 * `spokenTexts`. An empty transcript is echo by definition — there is nothing
 * in it to act on. With no spoken text known, nothing is echo: the safety path
 * must stay open when the cue text was not threaded through.
 */
export function isSpeechEcho(transcript: string, spokenTexts: readonly string[]): boolean {
  const heard = tokenize(transcript);
  if (heard.length === 0) return true;
  return spokenTexts.some((text) => {
    const spoken = new Set(tokenize(text));
    return spoken.size > 0 && coverage(heard, spoken) >= ECHO_COVERAGE;
  });
}
