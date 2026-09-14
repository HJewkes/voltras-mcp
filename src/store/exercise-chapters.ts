// The one operation every `exercise_chapters` reader performs (VW-361).
//
// A chapter is a DECLARED boundary after which the pre-boundary numbers stop
// being the thing to beat (rp:rp-s3-old-prs-irrelevant-reframe). Every consumer
// already derives a window start, so honouring the boundary is a clamp on that
// start and nothing else: no row is deleted, hidden or rewritten, and a reader
// that widens its own lookback still cannot see past the declaration.

/**
 * The later of a window start and the chapter start, so a clamped window never
 * reaches back past the declared boundary.
 *
 * `null` means the lifter declared no chapter for this exercise, and the
 * window passes through untouched — the pre-VW-361 behaviour, which is what
 * every exercise gets by default.
 *
 * ISO-8601 UTC instants compare correctly as strings, which is the same
 * assumption `getSetsForExercise`'s own `from`/`to` bindings make.
 */
export function clampToChapter(fromIso: string, chapterStartedAt: string | null): string {
  if (chapterStartedAt === null) return fromIso;
  return chapterStartedAt > fromIso ? chapterStartedAt : fromIso;
}
