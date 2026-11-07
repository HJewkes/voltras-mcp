// whisper.cpp transcript cleanup (VMCP-02.83).
//
// `nodejs-whisper`'s `nodewhisper` returns one line per segment with timestamp
// markup in front of the words:
//
//   "\n[00:00:00.000 --> 00:00:01.100]   Wait, stop the wait.\n"
//
// The producer now reads `transcribeDetailed().text`, which has no timestamps
// but can still hold non-speech tags, and a future backend or call path may
// bring the markup back. We clean the text on our side of the boundary.
//
// This is a SAFETY path, not cosmetics: `routeTranscript` only accepts a stop
// phrase inside a short word budget, and the markup spends that budget on
// tokens the speaker never said ("00:00:00.000", "-->", "00:00:00.840]"). A
// bare "stop" survived it; a reflexive "wait stop the weight" did not. Both the
// producer (defaultWhisper) and the consumer (routeTranscript) apply this, so a
// change in whisper's output format cannot silently re-open that hole.

/** `[hh:mm:ss.mmm --> hh:mm:ss.mmm]` segment markup, anywhere in the text. */
const TIMESTAMP_MARKUP =
  /\[\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}\s*\]/g;

// Non-speech annotations whisper emits in place of words: [BLANK_AUDIO] on a
// silent segment, plus [SOUND]/[MUSIC]/[NOISE]/[_BEG_]. Screaming-caps inside
// brackets is never transcribed speech, so the shape is safe to drop wholesale.
const NON_SPEECH_TAG = /\[[A-Z][A-Z0-9_]*\]/g;

/**
 * Strip whisper's markup, leaving only the words the speaker said. Segment
 * lines are joined with a space and whitespace is collapsed, so a multi-segment
 * utterance reads as one sentence.
 */
export function stripWhisperMarkup(raw: string): string {
  return raw
    .replace(TIMESTAMP_MARKUP, ' ')
    .replace(NON_SPEECH_TAG, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
