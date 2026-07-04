// HTTP sidecar that exposes voltras-mcp live state to a local browser
// dashboard. Pure `node:http` — no framework, no extra dependencies.
//
// ── Loopback only ─────────────────────────────────────────────────────────
//
// The server binds to `127.0.0.1` (default), NOT `0.0.0.0`. This is a
// deliberate security posture: the MCP process itself is a single-user
// stdio process, and the dashboard exposes session-scoped data plus a
// session-history listing. Allowing connections from anywhere on the LAN
// would surface that data to other devices on the same network without
// any auth check.
//
// If a future caller wants to reach the dashboard from a phone or another
// machine on their LAN, they should add an opt-in `host` override AND a
// bearer-token check. CORS headers are intentionally absent today for the
// same reason — once cross-origin reads are allowed, the loopback bind is
// the only thing keeping the dashboard private.
//
// ── Lifecycle ─────────────────────────────────────────────────────────────
//
// `startDashboardServer({ port, state })` returns a `DashboardServerHandle`
// once the underlying `http.Server` has emitted `listening`. Failures
// (port-in-use, EACCES) reject the returned promise rather than throwing
// asynchronously through an `error` event listener nobody catches. The
// handle's `close()` releases the port; idempotent so `runServer`'s
// shutdown hook can call it without tracking whether `start` succeeded.
//
// ── Endpoints ─────────────────────────────────────────────────────────────
//
//   GET /                — legacy vanilla-HTML dashboard (`dashboard-html.ts`).
//                          Zero-build, inline `<script>` polling `/api/snapshot`.
//                          Still the default route; see `src/dashboard/README.md`.
//   GET /app             — titan-design React SPA (Vite + react-native-web;
//                          Phases 0-5, VMCP-01.44 through VMCP-01.49). Serves
//                          the vite-built bundle from `dist/spa` (js/css under
//                          `/app/assets/*`). Additive; does not touch `/`.
//   GET /api/snapshot    — { session, devices, sets } JSON. Live view of
//                          the active session, every slot's device snapshot,
//                          and the active set if any.
//   GET /api/health      — { ok, version, uptimeMs } JSON.
//   GET /api/history     — { sessions: StoredSession[] } JSON. `?limit=N`
//                          query parameter, capped at 100.
//   GET /<anything else> — 404 JSON `{ error: 'not_found' }`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateE1RMFromReps, getRepPeakVelocity } from '@voltras/workout-analytics';

import { DASHBOARD_HTML } from './dashboard-html.js';
import { log } from '../logger.js';
import type { DeviceSnapshot, ActiveSession, ActiveSet } from '../state/live-state.js';
import type {
  StoredSession,
  StoredSet,
  StoredTrainingProgram,
  StoredTrainingBlock,
  StoredTrainingWeek,
  StoredWorkoutTemplate,
  StoredPlannedExercise,
  StoredProgramAssignment,
} from '../store/types.js';

/** Default loopback port. Configurable via `VMCP_DASHBOARD_PORT`. */
export const DEFAULT_DASHBOARD_PORT = 7723;
/** Default bind address — loopback only. See module header for rationale. */
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
/** Hard cap on `?limit=` for `/api/history`. Anything larger is clamped. */
export const HISTORY_MAX_LIMIT = 100;
/** Default `?limit=` for `/api/history` when the query parameter is absent. */
export const HISTORY_DEFAULT_LIMIT = 20;

export interface DashboardServerOptions {
  /** TCP port. Pass `0` for auto-assignment. Defaults to {@link DEFAULT_DASHBOARD_PORT}. */
  port?: number;
  /** Bind address. Defaults to `127.0.0.1` (loopback). */
  host?: string;
  /** Live server state. Snapshot/history endpoints read from this. */
  state: DashboardServerState;
}

/**
 * Narrow slice of `ServerState` the dashboard actually needs. Defining this
 * locally (rather than `Pick<ServerState, ...>`) keeps the test fakes simple
 * — they don't have to fabricate a full ServerState shape.
 */
export interface DashboardServerState {
  slots: ReadonlyMap<
    string,
    {
      live: {
        snapshotDevice(): DeviceSnapshot;
        snapshotSession(): ActiveSession | undefined;
        snapshotSet(): ActiveSet | undefined;
      };
    }
  >;
  store: {
    listSessions(filter: {
      sort: 'startedAt:desc' | 'startedAt:asc';
      limit: number;
      offset: number;
      exerciseId?: string;
    }): Promise<StoredSession[]>;
    /** Persisted sets (with full WA reps) for a session — feeds the e1RM trend. */
    getSetsForSession(sessionId: string): Promise<StoredSet[]>;
    // Plan-store reads for the idle "next workout" preview. Optional so the
    // server test fakes (and any store build without planning) degrade to no
    // preview rather than failing; the real sqlite store supplies them all.
    listTrainingPrograms?(opts?: { includeArchived?: boolean }): Promise<StoredTrainingProgram[]>;
    getTrainingBlocksForProgram?(programId: string): Promise<StoredTrainingBlock[]>;
    getTrainingWeeksForBlock?(blockId: string): Promise<StoredTrainingWeek[]>;
    getWorkoutTemplatesForWeek?(weekId: string): Promise<StoredWorkoutTemplate[]>;
    getPlannedExercisesForTemplate?(templateId: string): Promise<StoredPlannedExercise[]>;
    getAssignmentsForTemplate?(templateId: string): Promise<StoredProgramAssignment[]>;
    /** Plan assignments attached to a session — feeds the active-exercise prescription. */
    getAssignmentsForSession?(sessionId: string): Promise<StoredProgramAssignment[]>;
  };
  /**
   * Exercise catalog lookup, used to join the active session's `exerciseId` to
   * its target muscle groups for the dashboard BodyMap (VMCP-01.47). Optional so
   * the server test fakes need not fabricate a catalog; the real `ServerState`
   * always supplies it. Muscle groups are plain fitness metadata (not protocol
   * data), so surfacing them in the loopback snapshot JSON respects NDA NF-07.
   */
  exercises?: {
    getById(id: string): { muscleGroups: string[]; secondaryMuscleGroups?: string[] } | undefined;
  };
}

export interface DashboardServerHandle {
  /** The port the server actually bound to (resolved from `port: 0`). */
  readonly port: number;
  /** Stop accepting connections and free the port. Idempotent. */
  close(): Promise<void>;
}

interface DeviceEntry {
  slotId: string;
  device: DeviceSnapshot;
}

/**
 * The active session's target muscle groups (primary + secondary), joined from
 * the exercise catalog for the dashboard BodyMap. Plain fitness metadata —
 * never protocol data. Null when there is no active session or the exercise is
 * unknown / carries no muscle metadata.
 */
interface ActiveExerciseMuscles {
  primaryMuscles: string[];
  secondaryMuscles: string[];
}

interface SnapshotResponse {
  session: ActiveSession | null;
  devices: DeviceEntry[];
  sets: { active: ActiveSet | null };
  activeExercise: ActiveExerciseMuscles | null;
}

/**
 * Start the dashboard HTTP sidecar. Resolves once the server is listening on
 * the resolved port; rejects on bind failure (port-in-use, EACCES, etc.).
 */
export function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServerHandle> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const host = opts.host ?? DEFAULT_DASHBOARD_HOST;
  const startedAt = Date.now();

  const server = createServer((req, res) => {
    handleRequest(req, res, opts.state, startedAt).catch((err) => {
      log.warn('dashboard: handler threw', err);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
      } else {
        res.end();
      }
    });
  });

  return new Promise<DashboardServerHandle>((resolve, reject) => {
    const onListenError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onListenError);
      const address = server.address();
      const boundPort = typeof address === 'object' && address !== null ? address.port : port;
      resolve(makeHandle(server, boundPort));
    };
    server.once('error', onListenError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function makeHandle(server: Server, port: number): DashboardServerHandle {
  let closed = false;
  return {
    port,
    close(): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      return new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
        // Force-close any keep-alive connections so a hung browser tab
        // doesn't keep the listener alive past process shutdown. Tests
        // also rely on this to avoid leaking handles.
        server.closeAllConnections?.();
      });
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: DashboardServerState,
  startedAt: number,
): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const rawUrl = req.url ?? '/';
  // The first arg to URL must be a full URL — synth a base because
  // IncomingMessage.url is a path-only string.
  const url = new URL(rawUrl, 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/') {
    sendHtml(res, 200, DASHBOARD_HTML);
    return;
  }
  // Phase 0 React SPA (VMCP-01.44), served read-only under `/app` from the
  // vite-built bundle in `dist/spa`. Additive and parallel to the vanilla
  // `/` dashboard above — neither route touches the other.
  if (pathname === '/app' || pathname === '/app/') {
    serveSpaIndex(res);
    return;
  }
  if (pathname.startsWith('/app/')) {
    serveSpaAsset(res, pathname);
    return;
  }
  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      version: VMCP_VERSION,
      uptimeMs: Date.now() - startedAt,
    });
    return;
  }
  if (pathname === '/api/snapshot') {
    sendJson(res, 200, buildSnapshot(state));
    return;
  }
  if (pathname === '/api/history') {
    const sessions = await fetchHistory(state, url);
    sendJson(res, 200, { sessions });
    return;
  }
  if (pathname === '/api/exercise-trend') {
    const points = await fetchExerciseTrend(state, url);
    sendJson(res, 200, { points });
    return;
  }
  if (pathname === '/api/next-workout') {
    const workout = await fetchNextWorkout(state);
    sendJson(res, 200, { workout });
    return;
  }
  if (pathname === '/api/session-plan') {
    const plan = await fetchSessionPlan(state);
    sendJson(res, 200, { plan });
    return;
  }
  if (pathname === '/api/program-status') {
    const program = await fetchProgramStatus(state);
    sendJson(res, 200, { program });
    return;
  }
  if (pathname === '/api/muscle-volume') {
    const muscles = await fetchMuscleVolume(state);
    sendJson(res, 200, { muscles });
    return;
  }
  if (pathname === '/api/pr-history') {
    const records = await fetchPrHistory(state, url);
    sendJson(res, 200, { records });
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}

function buildSnapshot(state: DashboardServerState): SnapshotResponse {
  const devices: DeviceEntry[] = [];
  let session: ActiveSession | undefined;
  let activeSet: ActiveSet | undefined;
  for (const [slotId, slot] of state.slots) {
    devices.push({ slotId, device: slot.live.snapshotDevice() });
    // First slot wins for session/set — single-session contract today; if
    // a future slot has its own active session/set, the snapshot still
    // reports the primary one (devices[] always carries every slot).
    if (session === undefined) {
      session = slot.live.snapshotSession();
    }
    if (activeSet === undefined) {
      activeSet = slot.live.snapshotSet();
    }
  }
  return {
    session: session ?? null,
    devices,
    sets: { active: activeSet ?? null },
    activeExercise: resolveActiveExerciseMuscles(state, session),
  };
}

/**
 * Join the active session's `exerciseId` to its catalog muscle groups. Returns
 * null when there is no session, no `exerciseId`, no catalog wired, or the
 * exercise is unknown — the client renders an empty BodyMap in every such case.
 */
function resolveActiveExerciseMuscles(
  state: DashboardServerState,
  session: ActiveSession | undefined,
): ActiveExerciseMuscles | null {
  const exerciseId = session?.exerciseId;
  if (!exerciseId || !state.exercises) return null;
  const exercise = state.exercises.getById(exerciseId);
  if (!exercise) return null;
  return {
    primaryMuscles: exercise.muscleGroups ?? [],
    secondaryMuscles: exercise.secondaryMuscleGroups ?? [],
  };
}

async function fetchHistory(
  state: DashboardServerState,
  url: URL,
): Promise<readonly StoredSession[]> {
  const limit = parseLimit(url.searchParams.get('limit'));
  return state.store.listSessions({
    sort: 'startedAt:desc',
    limit,
    offset: 0,
  });
}

/** One point on the per-exercise estimated-1RM trend (titan StrengthTrendChart shape). */
interface ExerciseTrendPoint {
  /** ISO timestamp of the session. */
  date: string;
  /** Best estimated 1RM (lbs) across that session's sets of this exercise. */
  e1rm: number;
  /** True when this session set a new all-time e1RM in the returned window. */
  isPR: boolean;
}

/** The active session's exercise id (first slot with a session), for the default trend. */
function activeExerciseId(state: DashboardServerState): string | undefined {
  for (const [, slot] of state.slots) {
    const session = slot.live.snapshotSession();
    if (session?.exerciseId !== undefined) return session.exerciseId;
  }
  return undefined;
}

/**
 * Per-exercise estimated-1RM trend from persisted history. For each past session
 * of the exercise, the best `estimateE1RMFromReps(weight, repCount)` across its
 * sets becomes one chronological point; a running max flags PR sessions. Pure
 * fitness metadata over stored WA reps — no protocol data crosses the boundary.
 */
async function fetchExerciseTrend(
  state: DashboardServerState,
  url: URL,
): Promise<ExerciseTrendPoint[]> {
  const exerciseId = url.searchParams.get('exerciseId') ?? activeExerciseId(state);
  if (exerciseId === undefined || exerciseId === '') return [];
  const limit = parseLimit(url.searchParams.get('limit'));
  const sessions = await state.store.listSessions({
    sort: 'startedAt:asc',
    limit,
    offset: 0,
    exerciseId,
  });

  const points: ExerciseTrendPoint[] = [];
  let runningMax = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    const sets = await state.store.getSetsForSession(session.id);
    let best = 0;
    for (const set of sets) {
      if (set.reps.length < 1) continue;
      const est = estimateE1RMFromReps(set.weightLbs, set.reps.length).e1RM;
      if (Number.isFinite(est) && est > best) best = est;
    }
    if (best <= 0) continue;
    const e1rm = Math.round(best);
    const isPR = e1rm > runningMax;
    if (isPR) runningMax = e1rm;
    points.push({ date: session.startedAt, e1rm, isPR });
  }
  return points;
}

/** Next planned workout for the idle dashboard, shaped for titan `WorkoutCard`. */
interface NextWorkoutView {
  name: string;
  /** Free-form context line (block · week), shown where WorkoutCard renders "date". */
  date: string;
  totalSets: number;
  muscleGroups: Array<{ group: string; label: string }>;
  unit: 'lbs';
}

/**
 * The first not-yet-assigned template in the latest program — the same "what's
 * next" traversal the plan.next_workout tool performs, resolved here from the
 * store for the idle preview. Returns null when the plan store isn't available,
 * no program exists, or every template is done. Plan metadata only (names,
 * planned sets, catalog muscle groups) — no protocol data (NF-07).
 */
async function fetchNextWorkout(state: DashboardServerState): Promise<NextWorkoutView | null> {
  const { store } = state;
  if (
    store.listTrainingPrograms === undefined ||
    store.getTrainingBlocksForProgram === undefined ||
    store.getTrainingWeeksForBlock === undefined ||
    store.getWorkoutTemplatesForWeek === undefined ||
    store.getPlannedExercisesForTemplate === undefined ||
    store.getAssignmentsForTemplate === undefined
  ) {
    return null;
  }
  const programs = await store.listTrainingPrograms({ includeArchived: false });
  const program = programs[0];
  if (program === undefined) return null;

  for (const block of await store.getTrainingBlocksForProgram(program.id)) {
    for (const week of await store.getTrainingWeeksForBlock(block.id)) {
      for (const template of await store.getWorkoutTemplatesForWeek(week.id)) {
        const assignments = await store.getAssignmentsForTemplate(template.id);
        if (assignments.length > 0) continue; // already done
        const planned = await store.getPlannedExercisesForTemplate(template.id);
        const totalSets = planned.reduce((sum, ex) => sum + ex.targetSets, 0);
        const seen = new Set<string>();
        const muscleGroups: Array<{ group: string; label: string }> = [];
        for (const ex of planned) {
          for (const m of state.exercises?.getById(ex.exerciseId)?.muscleGroups ?? []) {
            if (seen.has(m)) continue;
            seen.add(m);
            muscleGroups.push({ group: m, label: m });
          }
        }
        const weekLabel = week.name ?? `Week ${week.orderIndex + 1}`;
        return {
          name: template.name,
          date: `${block.name} · ${weekLabel}`,
          totalSets,
          muscleGroups,
          unit: 'lbs',
        };
      }
    }
  }
  return null;
}

/** Prescribed targets for the active exercise, from its attached plan template. */
interface PrescriptionView {
  repsLow?: number;
  repsHigh?: number;
  weightLbs?: number;
  rpe?: number;
}

/**
 * The active exercise's prescription, when the live session is attached to a
 * workout template (plan.attach_to_session): find the planned exercise matching
 * the active exercise id and surface its target rep range / weight / RPE. Returns
 * null when the plan store isn't available, no session/exercise is active, or no
 * template-level attachment covers the active exercise. Single-exercise
 * (plannedExerciseId) attachments aren't resolved here — the store has no direct
 * getPlannedExercise(id); tracked as a follow-up. Plan metadata only (NF-07).
 */
async function fetchSessionPlan(state: DashboardServerState): Promise<PrescriptionView | null> {
  const { store } = state;
  if (
    store.getAssignmentsForSession === undefined ||
    store.getPlannedExercisesForTemplate === undefined
  ) {
    return null;
  }
  let session: ActiveSession | undefined;
  for (const [, slot] of state.slots) {
    const candidate = slot.live.snapshotSession();
    if (candidate !== undefined) {
      session = candidate;
      break;
    }
  }
  if (session === undefined || session.exerciseId === undefined) return null;
  const { sessionId, exerciseId } = session;

  for (const assignment of await store.getAssignmentsForSession(sessionId)) {
    if (assignment.workoutTemplateId === undefined) continue;
    const planned = await store.getPlannedExercisesForTemplate(assignment.workoutTemplateId);
    const match = planned.find((p) => p.exerciseId === exerciseId);
    if (match === undefined) continue;
    const prescription: PrescriptionView = {};
    if (match.targetRepsLow !== undefined) prescription.repsLow = match.targetRepsLow;
    if (match.targetRepsHigh !== undefined) prescription.repsHigh = match.targetRepsHigh;
    if (match.targetWeightLbs !== undefined) prescription.weightLbs = match.targetWeightLbs;
    if (match.targetRpe !== undefined) prescription.rpe = match.targetRpe;
    return prescription;
  }
  return null;
}

/** Current-block program status for the meso overview (titan MesoStatusCard). */
interface ProgramStatusView {
  mesoName: string;
  focus?: string;
  weekNumber: number;
  totalWeeks: number;
  workoutsDone: number;
  workoutsPlanned: number;
}

/**
 * Where the latest program stands: the first block that isn't fully assigned is
 * the "current" mesocycle — its name/focus, the current week (first week with an
 * unassigned template), and workouts done vs planned across the block. Returns
 * null when the plan store isn't available, no program exists, or every block is
 * complete. Plan metadata only (NF-07).
 */
async function fetchProgramStatus(state: DashboardServerState): Promise<ProgramStatusView | null> {
  const { store } = state;
  if (
    store.listTrainingPrograms === undefined ||
    store.getTrainingBlocksForProgram === undefined ||
    store.getTrainingWeeksForBlock === undefined ||
    store.getWorkoutTemplatesForWeek === undefined ||
    store.getAssignmentsForTemplate === undefined
  ) {
    return null;
  }
  const [program] = await store.listTrainingPrograms({ includeArchived: false });
  if (program === undefined) return null;

  for (const block of await store.getTrainingBlocksForProgram(program.id)) {
    let planned = 0;
    let done = 0;
    let currentWeekOrder = -1;
    for (const week of await store.getTrainingWeeksForBlock(block.id)) {
      for (const template of await store.getWorkoutTemplatesForWeek(week.id)) {
        planned += 1;
        const assignments = await store.getAssignmentsForTemplate(template.id);
        if (assignments.length > 0) done += 1;
        else if (currentWeekOrder === -1) currentWeekOrder = week.orderIndex;
      }
    }
    if (planned === 0 || done >= planned) continue; // empty or finished block
    const status: ProgramStatusView = {
      mesoName: block.name,
      weekNumber: (currentWeekOrder >= 0 ? currentWeekOrder : 0) + 1,
      totalWeeks: block.weeksCount,
      workoutsDone: done,
      workoutsPlanned: planned,
    };
    if (block.focus !== undefined) status.focus = block.focus;
    return status;
  }
  return null;
}

/** Days of history the weekly-volume rollup covers. */
const VOLUME_WINDOW_DAYS = 7;
/** Recent sessions scanned for the rollup (cap; a week rarely exceeds this). */
const VOLUME_SESSION_SCAN = 60;
/** Secondary muscles count as a fraction of a working set (standard heuristic). */
const SECONDARY_SET_WEIGHT = 0.5;

/**
 * Weekly effective sets per catalog muscle over the trailing {@link
 * VOLUME_WINDOW_DAYS} days: each session's set count is attributed to its
 * exercise's primary muscles (full) and secondary muscles (half), joined via the
 * exercise catalog. The client maps these onto titan's volume landmarks. Derived
 * fitness metadata only — no protocol data (NF-07).
 */
async function fetchMuscleVolume(
  state: DashboardServerState,
): Promise<Record<string, number> | null> {
  const catalog = state.exercises;
  if (catalog === undefined) return null;
  const cutoff = Date.now() - VOLUME_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const sessions = await state.store.listSessions({
    sort: 'startedAt:desc',
    limit: VOLUME_SESSION_SCAN,
    offset: 0,
  });

  const volume: Record<string, number> = {};
  for (const session of sessions) {
    if (Number.isFinite(Date.parse(session.startedAt)) && Date.parse(session.startedAt) < cutoff) {
      continue;
    }
    if (session.exerciseId === undefined) continue;
    const meta = catalog.getById(session.exerciseId);
    if (meta === undefined) continue;
    const setCount = (await state.store.getSetsForSession(session.id)).length;
    if (setCount === 0) continue;
    for (const muscle of meta.muscleGroups) {
      volume[muscle] = (volume[muscle] ?? 0) + setCount;
    }
    for (const muscle of meta.secondaryMuscleGroups ?? []) {
      volume[muscle] = (volume[muscle] ?? 0) + setCount * SECONDARY_SET_WEIGHT;
    }
  }
  return volume;
}

const PR_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** ISO timestamp → "MMM D" display date (UTC, deterministic). Falls back to raw. */
function fmtPrDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${PR_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** One PR record for titan PrHistoryModal. */
interface PrRecordView {
  type: 'e1rm' | 'weight' | 'reps' | 'velocity';
  value: number;
  unit?: 'lbs';
  date: string;
}

/**
 * All-time PR records for an exercise (defaults to the active one) from stored
 * history: best estimated 1RM, top set weight, most reps in a set, and fastest
 * rep — each with the date it was set. Derived fitness metadata only (NF-07).
 */
async function fetchPrHistory(state: DashboardServerState, url: URL): Promise<PrRecordView[]> {
  const exerciseId = url.searchParams.get('exerciseId') ?? activeExerciseId(state);
  if (exerciseId === undefined || exerciseId === '') return [];
  const sessions = await state.store.listSessions({
    sort: 'startedAt:asc',
    limit: parseLimit(url.searchParams.get('limit')),
    offset: 0,
    exerciseId,
  });

  const best = { e1rm: 0, weight: 0, reps: 0, velMms: 0 };
  const dates = { e1rm: '', weight: '', reps: '', velMms: '' };
  for (const session of sessions) {
    for (const set of await state.store.getSetsForSession(session.id)) {
      const reps = set.reps.length;
      if (reps < 1) continue;
      const e1 = estimateE1RMFromReps(set.weightLbs, reps).e1RM;
      if (Number.isFinite(e1) && e1 > best.e1rm) {
        best.e1rm = e1;
        dates.e1rm = session.startedAt;
      }
      if (set.weightLbs > best.weight) {
        best.weight = set.weightLbs;
        dates.weight = session.startedAt;
      }
      if (reps > best.reps) {
        best.reps = reps;
        dates.reps = session.startedAt;
      }
      for (const rep of set.reps) {
        const pv = getRepPeakVelocity(rep);
        if (typeof pv === 'number' && Number.isFinite(pv) && pv > best.velMms) {
          best.velMms = pv;
          dates.velMms = session.startedAt;
        }
      }
    }
  }

  const records: PrRecordView[] = [];
  if (best.e1rm > 0)
    records.push({
      type: 'e1rm',
      value: Math.round(best.e1rm),
      unit: 'lbs',
      date: fmtPrDate(dates.e1rm),
    });
  if (best.weight > 0)
    records.push({
      type: 'weight',
      value: Math.round(best.weight),
      unit: 'lbs',
      date: fmtPrDate(dates.weight),
    });
  if (best.reps > 0) records.push({ type: 'reps', value: best.reps, date: fmtPrDate(dates.reps) });
  if (best.velMms > 0)
    records.push({
      type: 'velocity',
      value: Number((best.velMms / 1000).toFixed(2)),
      date: fmtPrDate(dates.velMms),
    });
  return records;
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return HISTORY_DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return HISTORY_DEFAULT_LIMIT;
  if (parsed > HISTORY_MAX_LIMIT) return HISTORY_MAX_LIMIT;
  return parsed;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Directory holding the vite-built Phase 0 SPA bundle (VMCP-01.44). Populated by
 * `npm run build:dashboard`. Resolved relative to this compiled module
 * (`dist/dashboard/server.js` → `dist/spa`) so it works from the published dist.
 */
const SPA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'spa');

/** Shown at `/app` when the SPA hasn't been built yet (no `dist/spa`). */
const SPA_NOT_BUILT_HTML =
  '<!doctype html><meta charset="utf-8"><title>SPA not built</title>' +
  '<body style="font-family:system-ui;background:#101010;color:#f3f4f6;padding:32px">' +
  '<h1>Dashboard SPA not built</h1>' +
  '<p>Run <code>npm run build:dashboard</code> to generate <code>dist/spa</code>, then reload.</p>';

function serveSpaIndex(res: ServerResponse): void {
  try {
    sendHtml(res, 200, readFileSync(join(SPA_DIR, 'index.html'), 'utf8'));
  } catch {
    sendHtml(res, 503, SPA_NOT_BUILT_HTML);
  }
}

function serveSpaAsset(res: ServerResponse, pathname: string): void {
  const relative = pathname.slice('/app/'.length);
  const target = normalize(join(SPA_DIR, relative));
  // Path-traversal guard: the resolved file must stay inside SPA_DIR.
  if (target !== SPA_DIR && !target.startsWith(SPA_DIR + sep)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  try {
    sendAsset(res, readFileSync(target), contentTypeFor(target));
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

function sendAsset(res: ServerResponse, body: Buffer, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.json':
    case '.map':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}

interface PackageJsonShape {
  name?: string;
  version?: string;
}

/**
 * Walk up from this module to find voltras-mcp's `package.json` and return
 * its `version`. Mirrors the lookup in `tools/server-tools.ts` — duplicated
 * intentionally so the dashboard module has no dependency on the tool layer.
 */
function readVoltrasMcpVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = dirname(here);
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, 'package.json');
      try {
        const body = readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(body) as PackageJsonShape;
        if (parsed.name === 'voltras-mcp' && typeof parsed.version === 'string') {
          return parsed.version;
        }
      } catch {
        // not a manifest — keep walking
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return 'unknown';
}

const VMCP_VERSION = readVoltrasMcpVersion();
