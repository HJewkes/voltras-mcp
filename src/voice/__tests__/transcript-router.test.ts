// Unit tests for the pure transcript router (VMCP-02.77 P3).
// Pure string classification: direct import, no stubs.

import { describe, expect, it } from 'vitest';

import { SAFETY_PHRASES, routeTranscript } from '../transcript-router.js';

describe('routeTranscript — safety tier', () => {
  it('matches every configured safety phrase', () => {
    for (const phrase of SAFETY_PHRASES) {
      const result = routeTranscript(phrase);
      expect(result.tier).toBe('safety');
      expect(result.matchedPhrase).toBe(phrase);
    }
  });

  it('matches despite surrounding punctuation and case ("STOP!")', () => {
    const result = routeTranscript('STOP!');
    expect(result.tier).toBe('safety');
    expect(result.matchedPhrase).toBe('stop');
  });

  it('matches multi-word phrases ("cut the weight", "drop it")', () => {
    expect(routeTranscript('cut the weight')).toEqual({
      tier: 'safety',
      matchedPhrase: 'cut the weight',
    });
    expect(routeTranscript('drop it')).toEqual({ tier: 'safety', matchedPhrase: 'drop it' });
  });
});

describe('routeTranscript — word boundaries', () => {
  it('does not fire on "nonstop" or "stopwatch"', () => {
    expect(routeTranscript('nonstop').tier).toBe('ignore');
    expect(routeTranscript('stopwatch').tier).toBe('ignore');
  });
});

describe('routeTranscript — negation screen', () => {
  it('does not treat a negated keyword as safety', () => {
    expect(routeTranscript("don't stop").tier).not.toBe('safety');
    expect(routeTranscript('do not stop').tier).not.toBe('safety');
    expect(routeTranscript('no need to stop').tier).not.toBe('safety');
    expect(routeTranscript('keep going').tier).not.toBe('safety');
  });

  it('routes a bare negated keyword to ignore', () => {
    expect(routeTranscript("don't stop")).toEqual({ tier: 'ignore' });
  });
});

describe('routeTranscript — length gate', () => {
  it('does not fire safety when the keyword is buried in a long sentence', () => {
    const result = routeTranscript('we can stop after this set');
    expect(result.tier).not.toBe('safety');
    expect(result.tier).toBe('ignore');
  });

  it('still fires safety on short shouts', () => {
    expect(routeTranscript('stop now').tier).toBe('safety');
  });
});

describe('routeTranscript — wake tier', () => {
  it('strips the wake phrase into commandText', () => {
    expect(routeTranscript("hey coach, what's next")).toEqual({
      tier: 'wake',
      commandText: "what's next",
    });
  });

  it('returns an empty commandText when only the wake phrase is spoken', () => {
    expect(routeTranscript('hey coach')).toEqual({ tier: 'wake', commandText: '' });
  });

  it('honors custom wakePhrases', () => {
    const result = routeTranscript('yo trainer set me up', { wakePhrases: ['yo trainer'] });
    expect(result).toEqual({ tier: 'wake', commandText: 'set me up' });
  });

  it('ignores the default wake phrase when a custom one is supplied', () => {
    expect(routeTranscript("hey coach what's next", { wakePhrases: ['yo trainer'] }).tier).toBe(
      'ignore',
    );
  });
});

describe('routeTranscript — ignore tier', () => {
  it('drops plain ambient speech', () => {
    expect(routeTranscript('nice weather today')).toEqual({ tier: 'ignore' });
  });

  it('drops an empty transcript', () => {
    expect(routeTranscript('   ')).toEqual({ tier: 'ignore' });
  });
});

// Regression cover for the hardware defect (VMCP-02.83): whisper's raw stdout
// carries `[hh:mm:ss.mmm --> hh:mm:ss.mmm]` markup, which normalize() turned
// into three words and spent half the safety word budget on. A bare "stop"
// still fired, so the hole only opened for the natural reflexive utterance.
// Strings below are verbatim whisper-cli output captured on the bench.
describe('routeTranscript — whisper timestamp markup (safety regression)', () => {
  const TIMESTAMP = '[00:00:00.000 --> 00:00:00.840]';

  it('routes the timestamped and bare forms identically', () => {
    for (const bare of ['Stop.', 'wait stop the weight']) {
      expect(routeTranscript(`${TIMESTAMP}   ${bare}`)).toEqual(routeTranscript(bare));
    }
  });

  it('fires safety on a timestamped reflexive utterance', () => {
    expect(routeTranscript(`${TIMESTAMP}   wait stop the weight`)).toEqual({
      tier: 'safety',
      matchedPhrase: 'stop',
    });
  });

  it('fires safety on a timestamped bare stop', () => {
    expect(routeTranscript(`${TIMESTAMP}   Stop.`)).toEqual({
      tier: 'safety',
      matchedPhrase: 'stop',
    });
  });

  it('strips markup from a multi-segment transcript', () => {
    const raw = '\n[00:00:00.000 --> 00:00:01.100]   Hey coach,\n[00:00:01.100 --> 00:00:02.000]   what next\n';
    expect(routeTranscript(raw)).toEqual({ tier: 'wake', commandText: 'what next' });
  });

  it('drops [BLANK_AUDIO] so silent segments do not spend the safety budget', () => {
    const raw =
      '\n[00:00:00.000 --> 00:00:03.000]   [BLANK_AUDIO]\n' +
      '[00:00:03.000 --> 00:00:04.000]   wait stop the weight\n';
    expect(routeTranscript(raw)).toEqual({ tier: 'safety', matchedPhrase: 'stop' });
  });

  // The two markup patterns are stripped independently. This strip is the net
  // that stands if a future refactor bypasses the adapter-side clean, so
  // neither pattern may depend on the other being present to be removed.
  it('drops a bare [BLANK_AUDIO] tag with no timestamp attached', () => {
    expect(routeTranscript('[BLANK_AUDIO] wait stop the weight')).toEqual({
      tier: 'safety',
      matchedPhrase: 'stop',
    });
  });

  it('strips bare timestamp markup with no non-speech tag attached', () => {
    expect(routeTranscript('[00:00:03.000 --> 00:00:04.000] wait stop the weight')).toEqual({
      tier: 'safety',
      matchedPhrase: 'stop',
    });
  });

  it('routes a silence-only transcript to ignore', () => {
    expect(routeTranscript('\n[00:00:00.000 --> 00:00:09.400]   [BLANK_AUDIO]\n')).toEqual({
      tier: 'ignore',
    });
  });

  it('keeps the negation gate closed through the markup', () => {
    expect(routeTranscript(`${TIMESTAMP}   don't stop`).tier).not.toBe('safety');
    expect(routeTranscript(`${TIMESTAMP}   we can stop after this set`).tier).not.toBe('safety');
  });
});

describe('routeTranscript — precedence', () => {
  it('lets safety beat wake on a short utterance ("hey coach stop")', () => {
    expect(routeTranscript('hey coach stop')).toEqual({ tier: 'safety', matchedPhrase: 'stop' });
  });
});
