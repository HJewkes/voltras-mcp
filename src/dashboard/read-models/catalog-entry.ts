// Wire shape of `GET /api/exercises` (VW-120).
//
// A structural subset of `@voltras/workout-analytics`'s `Exercise`, declared
// with NO imports so both the server route and the SPA catalog browser can
// share one declaration instead of hand-mirroring it. (`ExerciseService`
// re-declares the full `Exercise` for the same reason — the analytics package
// did not publish the type at the version this repo pinned.)
//
// Plain fitness metadata: names, muscle groups, equipment. No protocol data (NF-07).

/** One catalog entry as the dashboard's exercise browser consumes it. */
export interface DashboardCatalogEntry {
  id: string;
  name: string;
  muscleGroups: string[];
  secondaryMuscleGroups?: string[];
  movementPattern?: string;
  exerciseType?: string;
  equipment?: { name: string; category: string }[];
  description?: string;
}
