import { describe, expect, it } from 'vitest';

import { SAFETY_PHRASES } from '../../transcript-router.js';
import { CUE_FOCUS_IDS, type CueFocusId } from '../focus.js';
import {
  FOCUS_PHRASES,
  focusPhrase,
  reinforcementPhrase,
  type CueRegister,
  type FocusPhraseSet,
} from '../focus-phrases.js';

const REGISTERS: readonly CueRegister[] = ['affirming', 'directive'];
const PHRASE_KINDS: readonly (keyof FocusPhraseSet)[] = ['affirming', 'directive', 'reinforcement'];

const everyPhrase = CUE_FOCUS_IDS.flatMap((focusId) =>
  PHRASE_KINDS.map((kind) => ({ focusId, kind, phrase: FOCUS_PHRASES[focusId][kind] })),
);

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safetyPhrasesIn(text: string): string[] {
  return SAFETY_PHRASES.filter((phrase) =>
    new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'i').test(text),
  );
}

describe('cue focus phrases', () => {
  it.each(
    CUE_FOCUS_IDS.flatMap((focusId) =>
      REGISTERS.map((register): [CueFocusId, CueRegister] => [focusId, register]),
    ),
  )('repeats %s in the %s register with byte-identical text', (focusId, register) => {
    const said = Array.from({ length: 5 }, () => focusPhrase(focusId, register));

    expect(new Set(said).size).toBe(1);
    expect(said[0]).toBe(FOCUS_PHRASES[focusId][register].text);
  });

  it('repeats the reinforcement line verbatim', () => {
    for (const focusId of CUE_FOCUS_IDS) {
      expect(reinforcementPhrase(focusId)).toBe(reinforcementPhrase(focusId));
    }
  });

  it('keeps every directive phrase to two or three words', () => {
    for (const focusId of CUE_FOCUS_IDS) {
      const words = focusPhrase(focusId, 'directive').split(/\s+/);

      expect(words.length).toBeGreaterThanOrEqual(2);
      expect(words.length).toBeLessThanOrEqual(3);
    }
  });

  it.each(everyPhrase)('keeps the $focusId $kind phrase free of safety words', ({ phrase }) => {
    expect(safetyPhrasesIn(phrase.text)).toEqual([]);
  });

  it('finds a safety word when one is present', () => {
    expect(safetyPhrasesIn('Now let go of the handle.')).toEqual(['let go']);
    expect(safetyPhrasesIn('Stop.')).toEqual(['stop']);
    expect(safetyPhrasesIn('Unstoppable drive.')).toEqual([]);
  });

  it('gives each focus a distinct phrase in every register', () => {
    for (const kind of PHRASE_KINDS) {
      const texts = CUE_FOCUS_IDS.map((focusId) => FOCUS_PHRASES[focusId][kind].text);

      expect(new Set(texts).size).toBe(CUE_FOCUS_IDS.length);
    }
  });

  it.each(everyPhrase)('records a source for the $focusId $kind phrase', ({ phrase }) => {
    expect(phrase.source.ref.length).toBeGreaterThan(0);
    if (phrase.source.kind === 'rp') {
      expect(phrase.source.ref).toMatch(/^rp-s\d+-[a-z0-9-]+(, rp-s\d+-[a-z0-9-]+)*$/);
    }
  });
});
