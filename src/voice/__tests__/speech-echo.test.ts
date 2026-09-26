// Unit tests for the muted-window self-echo filter (VMCP-05.20).
//
// This is the guard that lets the mic stay open to safety phrases while a cue
// plays: it has to catch our own voice coming back through whisper, including
// the fragments and reorderings whisper actually produces, without swallowing a
// short genuine shout over an unrelated cue.

import { describe, expect, it } from 'vitest';

import { isSpeechEcho } from '../speech-echo.js';

const CUE = 'That rep was 15 percent slower. Reset.';

describe('isSpeechEcho — our own voice', () => {
  it('matches the cue transcribed back verbatim', () => {
    expect(isSpeechEcho(CUE, [CUE])).toBe(true);
  });

  it('matches a fragment of the cue', () => {
    expect(isSpeechEcho('percent slower reset', [CUE])).toBe(true);
  });

  it('ignores casing and punctuation whisper adds or drops', () => {
    expect(isSpeechEcho('  THAT REP WAS 15 PERCENT SLOWER, RESET!! ', [CUE])).toBe(true);
  });

  it('matches against any of several cues speaking at once', () => {
    expect(isSpeechEcho('nice work last one', ['Two reps to go.', 'Nice work. Last one.'])).toBe(
      true,
    );
  });

  it('treats an empty transcript as echo — there is nothing in it to act on', () => {
    expect(isSpeechEcho('   ', [CUE])).toBe(true);
  });
});

describe('isSpeechEcho — the lifter', () => {
  it('does not match a safety phrase spoken over an unrelated cue', () => {
    expect(isSpeechEcho('stop', [CUE])).toBe(false);
    expect(isSpeechEcho('cut the weight', [CUE])).toBe(false);
  });

  it('does not match a longer utterance sharing a few cue words', () => {
    expect(isSpeechEcho('that was way too slow for me on this rep', [CUE])).toBe(false);
  });

  it('lets everything through when no spoken text is known', () => {
    expect(isSpeechEcho('stop', [])).toBe(false);
    expect(isSpeechEcho('stop', [''])).toBe(false);
  });
});

// The trade the design makes, pinned so it cannot change silently: a safety
// word that also appears in the cue being spoken is unreachable for that
// window. Keeping safety words out of CUE_CATALOG is what keeps this theoretical.
describe('isSpeechEcho — the documented residual risk', () => {
  it('swallows a real "stop" when the cue itself says stop', () => {
    expect(isSpeechEcho('stop', ["Don't stop now."])).toBe(true);
  });
});
