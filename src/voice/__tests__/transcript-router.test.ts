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

describe('routeTranscript — precedence', () => {
  it('lets safety beat wake on a short utterance ("hey coach stop")', () => {
    expect(routeTranscript('hey coach stop')).toEqual({ tier: 'safety', matchedPhrase: 'stop' });
  });
});
