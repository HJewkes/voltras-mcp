// Catalog wrapper for the exercise library.
//
// `ExerciseService` is a stateless, side-effect-free wrapper around
// `@voltras/workout-analytics`'s exercise catalog (R22). Wave 2C's
// `bootstrapState()` instantiates a single shared instance and stashes it on
// `state.exercises`; Wave 3 `exercise.search` / `exercise.get` tools and the
// `session.start` `exerciseId` validation step are the only callers.
//
// Why a class rather than free functions: every other long-lived collaborator
// on `ServerState` is a class (`LiveState`, `SessionStore` impls); keeping the
// shape uniform simplifies dependency injection in tests.
//
// ── Upstream-version note ─────────────────────────────────────────────────
// The exercise catalog API (`searchExercises`, `getExerciseById`, the
// `Exercise` type) ships in `@voltras/workout-analytics` v1.x and is not
// re-exported from the v0.2.0 entry point pinned in `package.json`. The
// runtime functions still resolve via the same module specifier; we cast the
// module namespace to the catalog surface so the wrapper compiles today and
// flips to a plain `import { searchExercises, getExerciseById } from ...`
// once VMCP bumps to a workout-analytics release that publishes the catalog.
// The local `Exercise` interface mirrors the published catalog shape (per
// `workout-analytics/src/exercises/types.ts`) and is the contract Wave 3
// returns to MCP clients — extra upstream fields stay invisible across the
// transport boundary as required by R22.
import * as analytics from '@voltras/workout-analytics';

/**
 * Public catalog entry returned by `exercise.search` and `exercise.get`.
 * Mirrors `Exercise` in `@voltras/workout-analytics/src/exercises/types.ts`.
 * Re-declared locally because v0.2.0 does not publish the type.
 */
export interface Exercise {
  /** Unique slug identifier (e.g. `"bench-press"`). */
  id: string;
  /** Display name. */
  name: string;
  /** Alternative search names. */
  aliases?: string[];
  /** Primary muscle groups worked. */
  muscleGroups: string[];
  /** Secondary muscle groups worked. */
  secondaryMuscleGroups?: string[];
  /** Movement pattern classification (push, pull, hinge, etc.). */
  movementPattern: string;
  /** Whether the lift is compound or isolation. */
  exerciseType: 'compound' | 'isolation';
  /** Equipment required to perform the lift. */
  equipment: { name: string; category: string }[];
  /** Whether the lift can be done with cables. */
  cableEquivalent: boolean;
  /** Cable setup details when `cableEquivalent` is true. */
  cableSetup?: { cablePath: string; attachments: string[]; notes?: string };
  /** Long-form description. */
  description?: string;
  /** Step-by-step execution instructions. */
  instructions?: string[];
  /** Form cues. */
  formCues?: string[];
  /** Common mistakes. */
  commonMistakes?: string[];
  /** Tips. */
  tips?: string[];
  /** Catalog-data completeness score (0-100+). */
  qualityScore: number;
}

/**
 * Catalog surface as the analytics package exposes it from v1.x onward.
 * Used as the cast target for the namespace import above.
 */
interface ExerciseCatalog {
  searchExercises: (query: string) => Exercise[];
  getExerciseById: (id: string) => Exercise | undefined;
}

const catalog = analytics as unknown as ExerciseCatalog;

/**
 * Thin facade over the analytics exercise catalog. Stateless: safe to share a
 * single instance across the server. All methods delegate 1:1 to the upstream
 * catalog functions and return results verbatim.
 */
export class ExerciseService {
  /**
   * Free-text search the catalog. Forwards `query` unchanged to
   * `searchExercises`; the upstream package owns ranking and casing. Returns
   * an empty array when no entries match.
   */
  search(query: string): Exercise[] {
    return catalog.searchExercises(query);
  }

  /**
   * Look up an exercise by its catalog id. Returns the entry as published by
   * the analytics package, or `undefined` when no row matches. Never throws
   * for unknown ids — Wave 3 tools translate `undefined` into the
   * `EXERCISE_NOT_FOUND` MCP error.
   */
  getById(id: string): Exercise | undefined {
    return catalog.getExerciseById(id);
  }
}
