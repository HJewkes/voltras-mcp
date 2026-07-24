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
//   GET /api/stream      — Server-Sent Events (`text/event-stream`) live
//                          overlay (VMCP-01.59): `phase` / `phaseflip` / `rep`
//                          / `set` derived signals + ~1 Hz `hb` keepalive.
//                          Additive to /api/snapshot (which stays the source of
//                          truth); the SPA degrades to poll-only without it.
//   GET /api/health      — { ok, version, uptimeMs } JSON.
//   GET /api/history     — { sessions: StoredSession[] } JSON. `?limit=N`
//                          query parameter, capped at 100.
//   GET /<anything else> — 404 JSON `{ error: 'not_found' }`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DASHBOARD_HTML } from './dashboard-html.js';
import { resolveTargetTempo } from './tempo-defaults.js';
import {
  buildSnapshotView,
  buildE1rmSeries,
  buildExerciseTrend,
  buildCapacityBand,
  buildPrHistory,
  buildMuscleVolume,
  deriveMesoWeekViews,
  type DeviceEntry,
  type SnapshotResponse,
  type HistorySession,
  type ExerciseTrendPoint,
  type CapacityBandPoint,
  type PrRecordView,
  type MuscleVolumeEntry,
  type MesoOverviewView,
  type RawMesoWeek,
} from './read-models/index.js';
import { log } from '../logger.js';
import type { LiveSignalHub } from '../state/live-signal.js';
import type {
  DeviceSnapshot,
  ActiveSession,
  ActiveSet,
  CompletedSetRecord,
} from '../state/live-state.js';
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
        /** VW-70 completed-set read. Optional so pre-VW-70 test fakes stay minimal. */
        snapshotCompletedSets?(): CompletedSetRecord[];
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
   * its display name and its target muscle groups for the dashboard BodyMap
   * (VMCP-01.47). Optional so the server test fakes need not fabricate a
   * catalog; the real `ServerState` always supplies it. Names and muscle groups
   * are plain fitness metadata (not protocol data), so surfacing them in the
   * loopback snapshot JSON respects confidentiality NF-07.
   */
  exercises?: {
    getById(id: string):
      | {
          name?: string;
          muscleGroups: string[];
          secondaryMuscleGroups?: string[];
          movementPattern?: string;
        }
      | undefined;
  };
  /**
   * Fan-out hub for the derived live signal, feeding the `GET /api/stream` SSE
   * endpoint (VMCP-01.59). Optional so the server test fakes (and any wiring
   * that never opens a telemetry source) can omit it — the stream route still
   * serves a valid, heartbeat-only `text/event-stream` in that case.
   */
  liveSignals?: LiveSignalHub;
}

export interface DashboardServerHandle {
  /** The port the server actually bound to (resolved from `port: 0`). */
  readonly port: number;
  /** Stop accepting connections and free the port. Idempotent. */
  close(): Promise<void>;
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

/**
 * True when a {@link startDashboardServer} rejection is a port-already-bound
 * (`EADDRINUSE`) failure — i.e. another process already holds the dashboard
 * port. Callers use this to escalate the log severity (see `server.ts`): a
 * port conflict is the one bind failure that silently hands the operator a
 * different server's dashboard, so it must be loud, not routine warn noise.
 */
export function isAddressInUse(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === 'EADDRINUSE'
  );
}

/**
 * Operator-facing explanation for an `EADDRINUSE` dashboard bind failure. A
 * second voltras-mcp instance already holds the port, so THIS session gets no
 * dashboard — and the dashboard visible on that port belongs to the OTHER
 * server, not this one. That exact confusion (an operator watching a dead
 * server's dashboard while live set data flowed to a portless one) is the
 * incident VW-68 addresses; the single shared daemon removes the race. Emitted
 * at error level so it can't be mistaken for the routine warn on the deliberately
 * non-fatal bind path.
 */
export function dashboardPortInUseMessage(port: number, host: string): string {
  return (
    `dashboard sidecar could NOT bind ${host}:${port} — another voltras-mcp ` +
    `instance already holds it. THIS session has NO dashboard; any dashboard open ` +
    `on ${host}:${port} belongs to the OTHER server and will NOT reflect this ` +
    `session's live set data. Stop the other instance, or set VMCP_DASHBOARD_PORT ` +
    `to a free port for this session. (VW-68: one shared daemon removes this race.)`
  );
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
    sendJson(res, 200, buildSnapshotWithRev(state));
    return;
  }
  if (pathname === '/api/stream') {
    serveStream(res, state);
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
  if (pathname === '/api/capacity-band') {
    const points = await fetchCapacityBand(state, url);
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
  if (pathname === '/api/meso-overview') {
    const meso = await fetchMesoOverview(state);
    sendJson(res, 200, { meso });
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

/** SSE keepalive cadence (~1 Hz). Doubles as the client's stream-staleness clock. */
const STREAM_HEARTBEAT_MS = 1000;

/**
 * `GET /api/stream` — the VMCP-01.59 Server-Sent Events endpoint. Registers the
 * response as a subscriber on the live-signal hub and streams `phase` /
 * `phaseflip` / `rep` / `set` events plus a ~1 Hz `hb` keepalive, in
 * `text/event-stream`.
 *
 * Structural push (VMCP-03.04): each `set` lifecycle boundary — the structural
 * transition the dashboard cares about (session/set start & end) — also pushes a
 * `snapshot` event carrying the fresh authoritative snapshot + its `rev`, so the
 * client reflects structure changes immediately instead of waiting for the (now
 * slow, ~2 s) reconciliation poll. The poll stays the correctness backstop;
 * losing the stream only costs latency on those transitions, never data.
 *
 * Multi-client-safe (the hub's subscriber set costs nothing) and self-cleaning:
 * the heartbeat timer and hub subscription are torn down when the socket
 * closes. Fitness-units-only payloads — no protocol data crosses the wire
 * (NF-07). When no hub is wired the stream is still valid, just heartbeat-only.
 */
function serveStream(res: ServerResponse, state: DashboardServerState): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  // `retry:` hints the browser's EventSource auto-reconnect backoff (3 s).
  res.write('retry: 3000\n\n');
  writeSseEvent(res, 'hb', { t: Date.now() });
  // VW-70: replay the current authoritative snapshot immediately on connect so a
  // late-joining or reconnecting client catches up on the active set AND the
  // session's completed sets without waiting for the next `set` boundary — SSE
  // has no event backlog, so without this a client that connects between sets
  // sees only heartbeats until the next set starts.
  writeSseEvent(res, 'snapshot', buildSnapshotWithRev(state));

  const unsubscribe = state.liveSignals?.subscribe((event) => {
    // Verbatim forwarder. The originating slot (VW-48) is already a field ON
    // the payload — stamped by `LiveSignalEmitter` — so there is nothing to
    // merge here, and no way for a future signal field to go missing because
    // someone forgot to add it to a per-event-type merge. Additive for existing
    // single-Voltra clients (`live-stream.ts`), which JSON.parse the body and
    // simply ignore the extra `slot` key; a dual-aware client demuxes on it.
    writeSseEvent(res, event.type, event.data);
    // A set lifecycle boundary is a structural transition: push the fresh
    // snapshot so the client updates structure without waiting for the poll.
    if (event.type === 'set') {
      writeSseEvent(res, 'snapshot', buildSnapshotWithRev(state));
    }
  });
  const heartbeat = setInterval(() => {
    writeSseEvent(res, 'hb', { t: Date.now() });
  }, STREAM_HEARTBEAT_MS);
  // Don't let the keepalive timer hold the event loop / process open.
  heartbeat.unref?.();

  res.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe?.();
  });
}

/** Serialize one SSE frame: a named `event:` plus its JSON `data:` payload. */
function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Gather the live device/session/set state (and the active exercise's catalog
 * entry) from every slot, then delegate all shaping to the pure snapshot
 * read-model. This is the I/O boundary — reading the live-state map and the
 * exercise catalog — while `buildSnapshotView` owns the (testable) output shape.
 */
function buildSnapshot(state: DashboardServerState): SnapshotResponse {
  const devices: DeviceEntry[] = [];
  let session: ActiveSession | undefined;
  let activeSet: ActiveSet | undefined;
  let completedSets: CompletedSetRecord[] = [];
  for (const [slotId, slot] of state.slots) {
    // Per-slot sets (VW-71): each slot's OWN active + completed sets ride on its
    // device entry so a bilateral (dual-Voltra) view reads per-limb telemetry. The
    // top-level `sets` below still reports the primary slot's for the single view.
    const slotActive = slot.live.snapshotSet();
    devices.push({
      slotId,
      device: slot.live.snapshotDevice(),
      sets: {
        active: slotActive ?? null,
        completed: slot.live.snapshotCompletedSets?.() ?? [],
      },
    });
    // First slot wins for session/set — single-session contract today; if
    // a future slot has its own active session/set, the snapshot still
    // reports the primary one (devices[] always carries every slot).
    if (session === undefined) {
      const slotSession = slot.live.snapshotSession();
      if (slotSession !== undefined) {
        session = slotSession;
        // Completed sets belong to the session that owns them — read them from
        // the same slot (VW-70). Optional-chained so a minimal test fake without
        // the method degrades to no completed sets rather than throwing.
        completedSets = slot.live.snapshotCompletedSets?.() ?? [];
      }
    }
    if (activeSet === undefined) {
      activeSet = slotActive;
    }
  }
  const exerciseId = session?.exerciseId;
  const activeExercise =
    exerciseId && state.exercises ? state.exercises.getById(exerciseId) : undefined;
  return buildSnapshotView({ devices, session, activeSet, completedSets, activeExercise });
}

/**
 * Monotonic send-order sequence stamped on every snapshot the server hands out —
 * over both `/api/snapshot` (poll) and the `snapshot` SSE push. Because it is
 * assigned synchronously at send time and JS is single-threaded, a higher `rev`
 * was built no earlier, so it reflects equal-or-fresher state. The client keeps
 * the last `rev` it applied and drops anything not strictly newer, so a slow
 * in-flight poll can never clobber a fresh push (or vice-versa), and the
 * completed-set fold never sees a set boundary twice.
 */
let snapshotRev = 0;

/** The authoritative snapshot plus its ordering stamp — the shape both channels send. */
type RevSnapshot = SnapshotResponse & { rev: number };

function buildSnapshotWithRev(state: DashboardServerState): RevSnapshot {
  return { ...buildSnapshot(state), rev: ++snapshotRev };
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

/** The active session's exercise id (first slot with a session), for the default trend. */
function activeExerciseId(state: DashboardServerState): string | undefined {
  for (const [, slot] of state.slots) {
    const session = slot.live.snapshotSession();
    if (session?.exerciseId !== undefined) return session.exerciseId;
  }
  return undefined;
}

/**
 * Gather the chronological (ascending) history for the requested exercise — its
 * past sessions plus each session's stored sets — the shared input the strength
 * trend, capacity band, and PR read-models fold. Resolves the exercise from the
 * `?exerciseId=` query or falls back to the active session; empty when neither
 * resolves. This is the I/O half; the derivation lives in `read-models/`.
 */
async function gatherExerciseHistory(
  state: DashboardServerState,
  url: URL,
): Promise<HistorySession[]> {
  const exerciseId = url.searchParams.get('exerciseId') ?? activeExerciseId(state);
  if (exerciseId === undefined || exerciseId === '') return [];
  const limit = parseLimit(url.searchParams.get('limit'));
  const sessions = await state.store.listSessions({
    sort: 'startedAt:asc',
    limit,
    offset: 0,
    exerciseId,
  });

  const history: HistorySession[] = [];
  for (const session of sessions) {
    const sets = await state.store.getSetsForSession(session.id);
    history.push({ startedAt: session.startedAt, sets });
  }
  return history;
}

/** Per-exercise estimated-1RM trend (titan StrengthTrendChart) from persisted history. */
async function fetchExerciseTrend(
  state: DashboardServerState,
  url: URL,
): Promise<ExerciseTrendPoint[]> {
  return buildExerciseTrend(buildE1rmSeries(await gatherExerciseHistory(state, url)));
}

/** Capacity band (Kalman corridor) over the exercise's per-session e1RM series. */
async function fetchCapacityBand(
  state: DashboardServerState,
  url: URL,
): Promise<CapacityBandPoint[]> {
  return buildCapacityBand(buildE1rmSeries(await gatherExerciseHistory(state, url)));
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

/**
 * One entry in the session's ordered planned-exercise list (VW-49). Mirrors the
 * client's `PlannedExerciseView` in `spa/adapter.ts` — the two must stay identical.
 */
interface PlannedExerciseView {
  /** Display name, or the exercise id when the catalog carries no name. Never invented. */
  name: string;
  /** 0-based position within the workout template. */
  order: number;
  /** Prescribed set count. */
  sets: number;
  repsLow?: number;
  repsHigh?: number;
  weightLbs?: number;
  /** True for the exercise the live session is currently on. */
  active: boolean;
}

/** Prescribed targets for the active exercise, from its attached plan template. */
interface PrescriptionView {
  /** Prescribed set count. Always present — `targetSets` is required on a planned exercise. */
  sets: number;
  repsLow?: number;
  repsHigh?: number;
  weightLbs?: number;
  rpe?: number;
  /** Prescribed rest between sets, seconds. Absent when the coach left it unset. */
  restSec?: number;
  /**
   * Target tempo tuple `[eccentric, pauseBottom, concentric, pauseTop]` (seconds),
   * resolved from the coach override (none yet) or the exercise default. Absent when
   * neither resolves — the live view then hides the tempo readout (VW-41).
   */
  tempo?: [number, number, number, number];
  /**
   * The session's FULL ordered planned-exercise list (VW-49) from the matched
   * template, so the rail can render `upcoming` rows beyond the active exercise.
   * Present whenever the prescription is; only real planned exercises, never invented.
   */
  exercises?: PlannedExerciseView[];
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
    const prescription: PrescriptionView = { sets: match.targetSets };
    if (match.targetRepsLow !== undefined) prescription.repsLow = match.targetRepsLow;
    if (match.targetRepsHigh !== undefined) prescription.repsHigh = match.targetRepsHigh;
    if (match.targetWeightLbs !== undefined) prescription.weightLbs = match.targetWeightLbs;
    if (match.targetRpe !== undefined) prescription.rpe = match.targetRpe;
    if (match.restSec !== undefined) prescription.restSec = match.restSec;
    // No coach-set tempo source yet (VW-41.1) — resolve the exercise default only.
    // The movement pattern, when the catalog knows it, widens coverage to the
    // per-pattern fallback; unknown exercise/pattern → null → tempo stays absent.
    const tempo = resolveTargetTempo(
      exerciseId,
      undefined,
      state.exercises?.getById(exerciseId)?.movementPattern,
    );
    if (tempo !== null) prescription.tempo = tempo;
    prescription.exercises = buildPlannedExerciseList(planned, exerciseId, state.exercises);
    return prescription;
  }
  return null;
}

/**
 * The template's planned exercises as an ordered `PlannedExerciseView[]` (VW-49):
 * sorted by `orderIndex`, named from the exercise catalog (falling back to the raw
 * exercise id — a real identifier, never an invented label), with the active exercise
 * flagged. Only real planned rows; an empty template yields an empty list.
 */
function buildPlannedExerciseList(
  planned: StoredPlannedExercise[],
  activeExerciseId: string,
  catalog: DashboardServerState['exercises'],
): PlannedExerciseView[] {
  return [...planned]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((p) => {
      const entry: PlannedExerciseView = {
        name: catalog?.getById(p.exerciseId)?.name ?? p.exerciseId,
        order: p.orderIndex,
        sets: p.targetSets,
        active: p.exerciseId === activeExerciseId,
      };
      if (p.targetRepsLow !== undefined) entry.repsLow = p.targetRepsLow;
      if (p.targetRepsHigh !== undefined) entry.repsHigh = p.targetRepsHigh;
      if (p.targetWeightLbs !== undefined) entry.weightLbs = p.targetWeightLbs;
      return entry;
    });
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

/**
 * Week-by-week overview of the active mesocycle — the first program's current
 * (in-progress, non-empty) block, folded into per-week volume + workout-status
 * data for titan `WeekRow`. Planned volume comes from each template's target
 * sets; workout status from plan assignments (the same done-signal the program
 * status + next-workout endpoints use). Returns null when the plan store isn't
 * available or no block is in progress. Plan metadata only (NF-07).
 */
async function fetchMesoOverview(state: DashboardServerState): Promise<MesoOverviewView | null> {
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
  const [program] = await store.listTrainingPrograms({ includeArchived: false });
  if (program === undefined) return null;

  for (const block of await store.getTrainingBlocksForProgram(program.id)) {
    const rawWeeks: RawMesoWeek[] = [];
    let planned = 0;
    let done = 0;
    for (const week of await store.getTrainingWeeksForBlock(block.id)) {
      const templates: RawMesoWeek['templates'] = [];
      let volume = 0;
      for (const template of await store.getWorkoutTemplatesForWeek(week.id)) {
        const isDone = (await store.getAssignmentsForTemplate(template.id)).length > 0;
        planned += 1;
        if (isDone) done += 1;
        const exercises = await store.getPlannedExercisesForTemplate(template.id);
        volume += exercises.reduce((sum, ex) => sum + ex.targetSets, 0);
        templates.push({ name: template.name, done: isDone });
      }
      const raw: RawMesoWeek = { orderIndex: week.orderIndex, volume, templates };
      if (week.name !== undefined) raw.name = week.name;
      rawWeeks.push(raw);
    }
    if (planned === 0 || done >= planned) continue; // empty or finished block

    const overview: MesoOverviewView = {
      mesoName: block.name,
      totalWeeks: block.weeksCount,
      weeks: deriveMesoWeekViews(rawWeeks),
    };
    if (block.focus !== undefined) overview.focus = block.focus;
    return overview;
  }
  return null;
}

/** Days of history the weekly-volume rollup covers. */
const VOLUME_WINDOW_DAYS = 7;
/** Recent sessions scanned for the rollup (cap; a week rarely exceeds this). */
const VOLUME_SESSION_SCAN = 60;

/**
 * Weekly effective sets per catalog muscle over the trailing {@link
 * VOLUME_WINDOW_DAYS} days. Gathers the in-window sessions, resolves each to its
 * catalog muscles + set count, and hands the entries to `buildMuscleVolume` for
 * the primary/secondary attribution. Derived fitness metadata only (NF-07).
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

  const entries: MuscleVolumeEntry[] = [];
  for (const session of sessions) {
    if (Number.isFinite(Date.parse(session.startedAt)) && Date.parse(session.startedAt) < cutoff) {
      continue;
    }
    if (session.exerciseId === undefined) continue;
    const meta = catalog.getById(session.exerciseId);
    if (meta === undefined) continue;
    const setCount = (await state.store.getSetsForSession(session.id)).length;
    entries.push({
      setCount,
      primaryMuscles: meta.muscleGroups,
      secondaryMuscles: meta.secondaryMuscleGroups ?? [],
    });
  }
  return buildMuscleVolume(entries);
}

/** All-time PR records for an exercise (defaults to the active one) from stored history. */
async function fetchPrHistory(state: DashboardServerState, url: URL): Promise<PrRecordView[]> {
  return buildPrHistory(await gatherExerciseHistory(state, url));
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
