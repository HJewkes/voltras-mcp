// Read-models: pure, I/O-free query projectors for the dashboard data layer.
//
// Each read-model takes plain, already-gathered state and returns a view shape,
// with no HTTP / BLE / store / socket dependency. `server.ts` stays a thin
// adapter that gathers state and calls these. See the dashboard data-layer
// architecture note (§3, "Read-models (query projectors)").

export {
  buildSnapshotView,
  resolveActiveExerciseMuscles,
  type DeviceEntry,
  type ActiveExerciseMuscles,
  type SnapshotResponse,
  type ExerciseMuscleMeta,
  type SnapshotInput,
} from './snapshot.js';
