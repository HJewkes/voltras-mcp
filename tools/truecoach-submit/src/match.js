// Resolving an outbox entry's exercises to the workout's results boxes.
//
// By name, never by index: supersets (E1/E2) reorder between the plan and the
// rendered page, so position carries no information. Matching is exact-first
// and then word-boundary containment, with no fuzzy scoring — an ambiguous
// name aborts the entry rather than guessing which of the coach's exercises
// gets the numbers.

/** Lowercase, diacritic-free, punctuation collapsed to single spaces. */
export function normalise(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Word-boundary containment: `row` matches `seated row`, not `narrow`. */
function containsPhrase(haystack, needle) {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

/**
 * `{ matches }` when every exercise resolves to exactly one distinct slot,
 * otherwise `{ unmatched }` naming each exercise that did not.
 */
export function matchExercises(exercises, slots) {
  const duplicates = duplicateNames(exercises);
  if (duplicates.length > 0) {
    return {
      unmatched: duplicates.map((name) => ({ exerciseName: name, reason: 'duplicate name' })),
    };
  }
  const matches = [];
  const unmatched = [];
  for (const exercise of exercises) {
    const candidates = resolveSlot(exercise.exerciseName, slots);
    if (candidates.length === 1) matches.push({ ...exercise, slot: candidates[0] });
    else unmatched.push({ exerciseName: exercise.exerciseName, reason: reasonFor(candidates) });
  }
  if (unmatched.length > 0) return { unmatched };
  return collidingSlots(matches) ?? { matches };
}

function reasonFor(candidates) {
  return candidates.length === 0 ? 'no matching exercise on the workout' : 'matches more than one';
}

/** Two entry exercises that normalise the same cannot be told apart. */
function duplicateNames(exercises) {
  const seen = new Map();
  for (const exercise of exercises) {
    const key = normalise(exercise.exerciseName);
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return exercises
    .filter((exercise) => seen.get(normalise(exercise.exerciseName)) > 1)
    .map((exercise) => exercise.exerciseName);
}

/** Exact title match wins outright; containment over title-plus-plan is the fallback. */
function resolveSlot(exerciseName, slots) {
  const name = normalise(exerciseName);
  if (name === '') return [];
  const exact = slots.filter((slot) => normalise(slot.title) === name);
  if (exact.length > 0) return exact;
  return slots.filter((slot) => {
    const title = normalise(slot.title);
    const haystack = normalise(`${slot.title} ${slot.plan ?? ''}`);
    return containsPhrase(haystack, name) || containsPhrase(name, title);
  });
}

/** Two exercises landing on one results box would overwrite each other. */
function collidingSlots(matches) {
  const byIndex = new Map();
  for (const match of matches) {
    const existing = byIndex.get(match.slot.index);
    if (existing === undefined) byIndex.set(match.slot.index, match);
    else
      return {
        unmatched: [existing, match].map((clash) => ({
          exerciseName: clash.exerciseName,
          reason: `both resolve to "${clash.slot.title}"`,
        })),
      };
  }
  return undefined;
}
