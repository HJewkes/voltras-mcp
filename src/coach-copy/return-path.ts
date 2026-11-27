// The coach copy a lifter can meet on the way back from a break or a miss, and the one rule it
// keeps: it never counts days (VW-987, VW-991). A returning lifter hears one past success, one
// small offer and one question; how long they were gone is never said back to them.
//
// Pure module with no imports, so `fragments.ts` can lint every registry with it.

/** Fragments on the return path, named one by one because their ids share no prefix. */
export const RETURN_PATH_FRAGMENT_IDS: readonly string[] = [
  'accountability.miss-recovery',
  'accountability.holding-acknowledgement',
  'accountability.ghost-nudge-1',
  'accountability.ghost-nudge-2',
  'composer.next-up',
  'composer.next-up-empty',
  'composer.load-clause',
  'composer.load-clause-return',
  'composer.re-entry-offer',
  'composer.booking',
  'composer.holding-maintenance',
  'composer.holding-through',
];

/** Whole areas on the return path, so a fragment added to one is linted without being listed. */
export const RETURN_PATH_ID_PREFIXES: readonly string[] = [
  'accountability.return-',
  'composer.return-',
  'live.derived-targets.',
];

/** A number or slot counting days, or a days slot on its own. */
export const DAY_COUNT = /(\d+|\{\{?\w+\}?\})[\s-]*days?\b|\{\{?days\w*\}?\}/i;

export function isReturnPath(id: string): boolean {
  return (
    RETURN_PATH_FRAGMENT_IDS.includes(id) ||
    RETURN_PATH_ID_PREFIXES.some((prefix) => id.startsWith(prefix))
  );
}

/** Why `text` may not stand on the return path, or `undefined` when it may. */
export function returnPathProblem(id: string, text: string): string | undefined {
  if (!isReturnPath(id) || !DAY_COUNT.test(text)) return undefined;
  return 'return-path text counts days';
}
