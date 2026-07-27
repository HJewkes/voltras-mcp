// Unit tests for the whisper stdout cleaner (VMCP-02.83).
//
// Every input string here is verbatim whisper-cli output captured on this
// machine (tiny.en, 16 kHz mono), not a hand-written approximation.

import { describe, expect, it } from 'vitest';

import { stripWhisperMarkup } from '../whisper-markup.js';

describe('stripWhisperMarkup', () => {
  it('strips the timestamp prefix from a single segment', () => {
    expect(stripWhisperMarkup('\n[00:00:00.000 --> 00:00:01.100]   Wait, stop the wait.\n')).toBe(
      'Wait, stop the wait.',
    );
  });

  it('strips the exact bench string', () => {
    expect(stripWhisperMarkup('[00:00:00.000 --> 00:00:00.840]   Stop.')).toBe('Stop.');
  });

  it('joins multiple segments into one sentence', () => {
    const raw =
      '\n[00:00:00.000 --> 00:00:01.100]   Hey coach,\n' +
      '[00:00:01.100 --> 00:00:02.400]   what is next?\n';
    expect(stripWhisperMarkup(raw)).toBe('Hey coach, what is next?');
  });

  it('drops [BLANK_AUDIO] and other bracketed non-speech tags', () => {
    expect(stripWhisperMarkup('\n[00:00:00.000 --> 00:00:09.400]   [BLANK_AUDIO]\n')).toBe('');
    expect(stripWhisperMarkup('[00:00:00.000 --> 00:00:01.000]   [MUSIC] stop')).toBe('stop');
  });

  it('tolerates timestamp shapes we did not capture', () => {
    expect(stripWhisperMarkup('[0:00:00.0 --> 0:00:01.5] stop')).toBe('stop');
    expect(stripWhisperMarkup('[00:00:00,000 --> 00:00:01,100] stop')).toBe('stop');
  });

  it('leaves already-clean text alone apart from trimming', () => {
    expect(stripWhisperMarkup('  wait stop the weight  ')).toBe('wait stop the weight');
  });

  it('does not eat ordinary words or bracketed lowercase text', () => {
    expect(stripWhisperMarkup('stop [now]')).toBe('stop [now]');
  });

  it('returns empty for empty input', () => {
    expect(stripWhisperMarkup('')).toBe('');
  });
});
