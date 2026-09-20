// What the rest between the two sets of a pair contained (VW-445 s.3.1), and the one
// predicate that decides whether a word belongs in `learned_rest.context`.
//
// FREE TEXT IN THE SCHEMA, VALIDATED HERE (OWNER, VW-525). The column carries no
// enumerated CHECK on purpose: each resistance family will later learn its own rest and
// the family goes in this column. Widening a CHECK is a migration; widening this array is
// a line of code. The two words below are what version 1 can produce, not the column's
// ceiling — `interleaved` is unreachable today and exists so a later superset rule cannot
// read straight-set values as its own.

/** The contexts version 1 admits. Add to this array, never to a CHECK. */
export const LEARNED_REST_CONTEXTS = ['straight', 'interleaved'] as const;

export type LearnedRestContext = (typeof LEARNED_REST_CONTEXTS)[number];

/** What the column defaults to, in both the DDL and any caller that states no context. */
export const DEFAULT_LEARNED_REST_CONTEXT: LearnedRestContext = 'straight';

/**
 * Is `value` a context this build knows? The schema cannot answer this, so every write
 * path into `learned_rest` has to ask before it inserts.
 */
export function isLearnedRestContext(value: string): value is LearnedRestContext {
  return (LEARNED_REST_CONTEXTS as readonly string[]).includes(value);
}
