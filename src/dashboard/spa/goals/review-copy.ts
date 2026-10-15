/**
 * What the goals page says when `/api/goals` reports days nobody has marked
 * training or test (VW-514). Those days are withheld from every count on the
 * page (VW-489), so without this line an empty week reads as no training.
 *
 * The wording is the owner's to approve: `{days}` is the only part the code fills.
 */
export const UNREVIEWED_LINE =
  "These numbers leave out {days} you haven't marked as training or test yet.";

/** The line for `unreviewedDays`, or `null` when nothing is withheld. */
export function unreviewedLine(unreviewedDays: number | undefined): string | null {
  if (unreviewedDays === undefined || unreviewedDays <= 0) return null;
  const days = unreviewedDays === 1 ? '1 day' : `${unreviewedDays} days`;
  return UNREVIEWED_LINE.replace('{days}', days);
}
