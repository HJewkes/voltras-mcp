// Freshness refusals. No network, no browser.

import { describe, it, expect } from 'vitest';

import { checkFreshness, DEFAULT_STALE_HOURS } from '../src/freshness.js';

const ENDED_AT = '2026-09-08T18:00:00.000Z';
const NOW = Date.parse('2026-09-08T19:00:00.000Z');

function entry(overrides = {}) {
  return {
    sessionId: 'session-1',
    endedAt: ENDED_AT,
    generatedAt: '2026-09-08T18:00:01.000Z',
    date: '2026-09-08',
    exercises: [{ exerciseId: 'row', exerciseName: 'Seated Row', result: '170 lb x 12' }],
    ...overrides,
  };
}

describe('checkFreshness', () => {
  it('passes a session that ended an hour ago', () => {
    expect(checkFreshness(entry(), { now: NOW })).toBeUndefined();
  });

  it('refuses an entry with no exercises', () => {
    // Arrange
    const empty = entry({ exercises: [] });

    // Act
    const refusal = checkFreshness(empty, { now: NOW });

    // Assert
    expect(refusal?.code).toBe('empty');
  });

  it('refuses an entry generated before the session ended', () => {
    // Arrange
    const backwards = entry({ generatedAt: '2026-09-08T17:59:59.000Z' });

    // Act
    const refusal = checkFreshness(backwards, { now: NOW });

    // Assert
    expect(refusal?.code).toBe('generated_before_end');
  });

  it('refuses a session older than the stale window', () => {
    // Arrange: two hours past the default window.
    const later = NOW + (DEFAULT_STALE_HOURS + 2) * 3_600_000;

    // Act
    const refusal = checkFreshness(entry(), { now: later });

    // Assert
    expect(refusal?.code).toBe('stale');
  });

  it('honours a shortened stale window', () => {
    // Arrange + Act
    const refusal = checkFreshness(entry(), { now: NOW, staleHours: 0.5 });

    // Assert
    expect(refusal?.code).toBe('stale');
  });

  it('refuses an entry whose timestamps are not parseable', () => {
    expect(checkFreshness(entry({ endedAt: 'yesterday' }), { now: NOW })?.code).toBe('empty');
  });
});
