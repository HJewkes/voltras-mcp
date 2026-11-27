// The registry lint keeps day counts out of return-path copy (VW-987, VW-991): a lifter coming
// back from a break or a miss is never told how long they were gone.

import { describe, expect, it } from 'vitest';

import { COACH_FRAGMENTS, validateFragment, validateRegistry } from '../fragments.js';
import {
  DAY_COUNT,
  RETURN_PATH_FRAGMENT_IDS,
  RETURN_PATH_ID_PREFIXES,
  isReturnPath,
} from '../return-path.js';

const REGISTRY_IDS = COACH_FRAGMENTS.map(({ id }) => id);
const RETURN_PATH = COACH_FRAGMENTS.filter(({ id }) => isReturnPath(id));

const SOURCED = {
  sourceKind: 'engineering-default',
  sourceRef: 'A fixture reason long enough to count as a sentence.',
} as const;

describe('return-path coverage', () => {
  it.each(RETURN_PATH_FRAGMENT_IDS)('%s is a fragment in the registry', (id) => {
    expect(REGISTRY_IDS).toContain(id);
  });

  it.each(RETURN_PATH_ID_PREFIXES)('the %s area holds at least one fragment', (prefix) => {
    expect(REGISTRY_IDS.some((id) => id.startsWith(prefix))).toBe(true);
  });

  it('covers the return greeting, the miss-recovery offer and the stale wall caption', () => {
    const ids = RETURN_PATH.map(({ id }) => id);

    expect(ids).toEqual(
      expect.arrayContaining([
        'accountability.return-greeting',
        'composer.return-success',
        'composer.return-baseline-offer',
        'composer.return-question',
        'composer.re-entry-offer',
        'composer.load-clause-return',
        'live.derived-targets.caption-stale',
      ]),
    );
  });
});

describe('return-path copy on main counts no days', () => {
  it('the whole registry passes the lint', () => {
    expect(validateRegistry(COACH_FRAGMENTS)).toEqual([]);
  });

  it.each(RETURN_PATH.map((fragment) => [fragment.id, fragment.text] as const))(
    '%s holds no day count',
    (_id, text) => {
      expect(text).not.toMatch(DAY_COUNT);
    },
  );
});

describe('the lint', () => {
  it.each([
    '26 days ago',
    '1 day ago',
    'a 15-day break',
    'back after 3 days',
    '{{days}} days ago',
    '{{days}} since then',
    '{{age}} days ago',
    '{n} days ago',
  ])('rejects "%s" on the return path', (text) => {
    const problems = validateFragment({ id: 'composer.return-fixture', text, ...SOURCED });

    expect(problems).toContain('return-path text counts days');
  });

  it('allows a date and a break with no count', () => {
    const text = 'Last time · 2026-09-24, before a break';

    expect(validateFragment({ id: 'live.derived-targets.fixture', text, ...SOURCED })).toEqual([]);
  });

  it('allows a named day and a training-day total', () => {
    const text = 'Training days on your record: 42. Friday works, or tomorrow.';

    expect(validateFragment({ id: 'composer.return-fixture', text, ...SOURCED })).toEqual([]);
  });

  it('leaves a day count off the return path alone', () => {
    const text = 'Rolling 28-day training days: 9.';

    expect(validateFragment({ id: 'composer.rolling-fixture', text, ...SOURCED })).toEqual([]);
  });
});
