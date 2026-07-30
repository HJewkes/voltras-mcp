// Read-models: pure, I/O-free query projectors for the dashboard data layer.
//
// Each read-model takes plain, already-gathered state and returns a view shape,
// with no HTTP / BLE / store / socket dependency. `server.ts` stays a thin
// adapter that gathers state and calls these. See the dashboard data-layer
// architecture note (§3, "Read-models (query projectors)").

export {
  buildSnapshotView,
  resolveActiveExerciseMuscles,
  resolveSessionView,
  type DeviceEntry,
  type ActiveExerciseMuscles,
  type SnapshotResponse,
  type ExerciseMeta,
  type SnapshotInput,
} from './snapshot.js';

export type { DashboardCatalogEntry } from './catalog-entry.js';

export type {
  SessionSummaryExercise,
  SessionSummaryProgression,
  SessionSummarySet,
  SessionSummaryView,
} from './session-summary-view.js';

export {
  buildPlanTreeView,
  nextOrderIndex,
  type ExerciseNameLookup,
  type PlanBlockView,
  type PlanExerciseView,
  type PlanProgramSummary,
  type PlanProgramView,
  type PlanTemplateView,
  type PlanTreeRows,
  type PlanTreeView,
  type PlanWeekView,
} from './plan-tree.js';
