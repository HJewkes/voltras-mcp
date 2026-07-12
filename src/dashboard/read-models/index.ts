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

export {
  buildE1rmSeries,
  buildExerciseTrend,
  buildCapacityBand,
  buildPrHistory,
  fmtPrDate,
  CAPACITY_BAND_K_SIGMA,
  MIN_CAPACITY_BAND_SESSIONS,
  type HistorySession,
  type HistorySet,
  type ExerciseE1rmObservation,
  type ExerciseTrendPoint,
  type CapacityBandPoint,
  type PrRecordView,
} from './exercise-history.js';

export {
  buildMuscleVolume,
  SECONDARY_SET_WEIGHT,
  type MuscleVolumeEntry,
} from './muscle-volume.js';

export {
  deriveMesoWeekViews,
  type MesoWorkoutView,
  type MesoWeekView,
  type MesoOverviewView,
  type RawMesoWeek,
} from './meso-overview.js';
