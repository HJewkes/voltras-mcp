// Whether an outbox entry is still safe to post.
//
// The stale window exists because the coach's calendar day rolls: a post that
// lands a day late lands on the wrong workout, and TrueCoach results are
// freeform text with no way to tell the coach it was misfiled.

export const DEFAULT_STALE_HOURS = 36;

/** Returns a refusal `{ code, detail }`, or undefined when the entry is fresh. */
export function checkFreshness(entry, { now = Date.now(), staleHours = DEFAULT_STALE_HOURS } = {}) {
  if (!Array.isArray(entry.exercises) || entry.exercises.length === 0) {
    return { code: 'empty', detail: 'no exercises in the entry' };
  }
  const endedAt = Date.parse(entry.endedAt);
  const generatedAt = Date.parse(entry.generatedAt);
  if (!Number.isFinite(endedAt) || !Number.isFinite(generatedAt)) {
    return { code: 'empty', detail: 'endedAt or generatedAt is not a timestamp' };
  }
  if (generatedAt < endedAt) {
    return { code: 'generated_before_end', detail: 'generatedAt precedes endedAt' };
  }
  const ageHours = (now - endedAt) / 3_600_000;
  if (ageHours > staleHours) {
    return {
      code: 'stale',
      detail: `session ended ${ageHours.toFixed(1)}h ago (max ${staleHours})`,
    };
  }
  return undefined;
}
