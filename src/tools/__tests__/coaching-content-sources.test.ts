// Every `coaching.explain` source is a followable key (VW-728): an RP corpus
// id, an author-year slug, or an author-year citation carrying its DOI.

import { describe, expect, it } from 'vitest';
import { COACHING_CONTENT } from '../coaching-content.js';

const RP_ID = /^rp-s\d+-[a-z0-9-]+$/;
const AUTHOR_YEAR_SLUG = /^[a-z][a-z-]*-(19|20)\d{2}-[a-z0-9-]+$/;
const YEAR = /\b(19|20)\d{2}\b/;
const DOI = /\b10\.\d{4,9}\/\S+$/;

function isFollowableSource(source: string): boolean {
  if (RP_ID.test(source) || AUTHOR_YEAR_SLUG.test(source)) return true;
  return YEAR.test(source) && DOI.test(source);
}

const SOURCES = Object.entries(COACHING_CONTENT).flatMap(([topic, content]) =>
  content.sources.map((source) => [topic, source] as const),
);

describe('coaching.explain sources', () => {
  it.each(SOURCES)('%s cites a followable source: %s', (_topic, source) => {
    expect(isFollowableSource(source)).toBe(true);
  });

  it.each([
    ['an rp id', 'rp-s10-checkin-cadence', true],
    ['an author-year slug', 'banyard-2017-1rm-and-velocity-reliability-jscr', true],
    [
      'a citation with its DOI',
      'Jukic et al., Sports Medicine, 2023 — 10.1007/s40279-022-01754-4',
      true,
    ],
    ['free prose', 'RP ghost protocol', false],
    ['a citation with no DOI', 'Someone et al., A Journal, 2020', false],
  ])('the shape check accepts %s: %s', (_label, source, expected) => {
    expect(isFollowableSource(source)).toBe(expected);
  });
});
