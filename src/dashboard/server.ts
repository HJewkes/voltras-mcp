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
//   GET /                — 302 to `/app`. The root is what an operator types
//                          from memory, so it must land on the dashboard.
//   GET /app             — titan-design React SPA (Vite + react-native-web),
//                          served read-only from the vite-built bundle in
//                          `dist/spa` (js/css under `/app/assets/*`). The sole
//                          dashboard surface — always renders the live page.
//   GET /api/snapshot    — { session, devices, sets } JSON. Live view of
//                          the active session, every slot's device snapshot,
//                          and the active set if any.
//   GET /api/stream      — Server-Sent Events (`text/event-stream`) live
//                          overlay (VMCP-01.59): `phase` / `phaseflip` / `rep`
//                          / `set` / `isometric` (VW-198) / `isometric_result`
//                          (VW-264) derived signals + ~1 Hz `hb` keepalive.
//                          Additive to /api/snapshot (which stays the source of
//                          truth); the SPA degrades to poll-only without it.
//   GET /api/health      — { ok, version, uptimeMs } JSON.
//   GET /api/history     — { sessions: StoredSession[] } JSON. `?limit=N`
//                          query parameter, capped at 100.
//   GET /api/session-plan — the active session's prescription (sets/reps/load/
//                          tempo/rest + the planned-exercise rail), or `{ plan:
//                          null }` when the session carries no plan.
//
//   ── Plan builder (VW-120) ───────────────────────────────────────────────
//   GET  /api/exercises   — `{ exercises }` catalog browse. `?q=` free-text,
//                          `?muscle=` primary-muscle filter, `?limit=`.
//   GET  /api/plan-tree   — `{ programs, program, activeTemplateId,
//                          activeExerciseId }`. `?programId=` selects; default is
//                          the most recent non-archived program. Poll this to see
//                          an agent's `plan.*` writes appear live.
//   GET  /api/muscle-plan — `{ weekStart, weekIndex, isDeload, muscleMapVersion,
//                          muscles: [{ muscle, plannedSetsThisWeek, doneSetsThisWeek,
//                          plannedRemaining }] }` for the active training week (VW-331,
//                          B4 of the body-map plan) — every titan muscle group (VW-328),
//                          zeros included. 404 `{ error: 'not_found' }` when no training
//                          week is currently active.
//   GET  /api/muscle-week — `{ weekStart, muscleMapVersion, landmarkBasis,
//                          muscles: [{ muscle, sets, status, landmarks,
//                          lastTrainedAt }] }` — weekly working sets per titan muscle
//                          group against the POPULATION volume landmarks (VW-329, B2 of
//                          the body-map plan). `?weekStart=` picks a week by any ISO
//                          instant inside it; default is the current week. Every titan
//                          muscle group, zeros included.
//   GET  /api/muscle-recovery — `{ muscleMapVersion, muscles: [{ muscle, lastTrainedAt,
//                          daysSince, lastEntryDepression, lastSessionMatchedPrior,
//                          reason }] }` over a trailing 56-day window (VW-332, B5 of the
//                          body-map plan). Elapsed days, the entry-depression read from
//                          that session, and whether it matched or beat its previous
//                          comparable session. No recovery window is computed.
//
//   ── Goal coach (VW-352, G5 of the goal-coach plan) ──────────────────────
//   GET  /api/goals       — `{ priorities: [{ priority, targets, rollup }], mesocycle }`. Every
//                          declared priority (`goal.declare_priorities`), its ACCEPTED
//                          targets, and the `buildPriorityRollup` verdict across them
//                          (`null` when none are accepted yet).
//   GET  /api/goal-progress?priorityId= — `{ targets: GoalProgressView[] }`, one view per
//                          non-retired target under the priority, from `buildGoalProgressView`.
//                          404 `{ error: 'not_found' }` for an unknown or retired priorityId.
//   POST /api/plan/programs                      — create a program + its first
//                          block/week/workout (see `plan-api.ts` for why).
//   POST /api/plan/programs/:id/workouts         — add a workout template.
//   POST /api/plan/templates/:id/exercises       — append a planned exercise.
//   POST /api/plan/templates/:id/reorder         — rewrite exercise order.
//   PATCH /api/plan/exercises/:id                — edit one exercise's targets.
//   DELETE /api/plan/exercises/:id               — unplan one exercise and close
//                          the gap it leaves in the template's order (VW-121).
//
//                          All six carry the SAME guards — a loopback `Host`,
//                          a matching `Origin`, a JSON content type and the
//                          per-boot write token (VW-500, `write-guard.ts`).
//                          The guard runs before route matching, so a seventh
//                          write route cannot be added unguarded. None of the
//                          six needs the single-writer device lease: every one
//                          is a sqlite plan write through `plan-api.ts` with
//                          no device I/O. See `README.md` for the table.
//
//   GET /api/bootstrap    — `{ token, version }`. The SPA's recovery path for
//                          the write token when its page predates a restart.
//                          Same-origin only, and unreadable cross-origin
//                          because the sidecar sends no CORS headers.
//
//   ── Session completion (VW-120) ─────────────────────────────────────────
//   GET /api/session-summary/:sessionId — per-exercise VBT rollup + progression
//                          recommendation for a finished session. `:sessionId`
//                          may be `latest`.
//
//   ── Body map (VW-330) ───────────────────────────────────────────────────
//   GET /api/muscle-strength — per titan muscle, its primary exercises with
//                          best e1RM, 12-week slope, PR flag and a
//                          multi-exercise agreement flag. One row per side.
//
//   ── Banners (VW-504, coach stage 1.5) ───────────────────────────────────
//   GET /api/banners      — `{ banner: BannerRecord | null }`: the single
//                          highest-priority banner that currently holds, or
//                          `null`. A store without the planning reads answers
//                          200 `{ banner: null }` — nothing to say is a valid
//                          answer here, unlike the plan routes' 501.
//
//   GET /<anything else> — 404 JSON `{ error: 'not_found' }`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFatigueAxesLookup,
  buildHistoryView,
  buildMusclePlanView,
  buildMuscleRecoveryView,
  buildMuscleWeekView,
  buildSessionPlanView,
  buildSessionSummary,
  buildSessionPaceView,
  buildSnapshotView,
  composeSessionTitle,
  recordWithEffort,
  withEffort,
  resolveSummarySessionId,
  startOfCalendarWeekIso,
  type DashboardSessionStore,
  type DeviceEntry,
  type MusclePlanTemplateRow,
  type MusclePlanView,
  type MuscleRecoveryView,
  type MuscleWeekView,
  type PrescriptionView,
  type SessionPaceView,
  type SessionPlanRows,
  type SnapshotCompletedSet,
  type SnapshotSet,
  type SnapshotResponse,
} from './read-models/index.js';
import type { DashboardCatalogEntry } from './read-models/catalog-entry.js';
import {
  createPlannedExercise,
  createProgramWithScaffold,
  createWorkout,
  deletePlannedExercise,
  fetchPlanTree,
  PlanApiError,
  reorderPlannedExercises,
  updatePlannedExercise,
  type DashboardPlanStore,
} from './plan-api.js';
import { fetchMuscleStrength, type MuscleStrengthStore } from './muscle-strength-api.js';
import {
  bootstrapFetchSiteAllowed,
  checkWriteRequest,
  injectWriteToken,
  mintWriteToken,
  WRITE_TOKEN_HEADER,
} from './write-guard.js';
import type { CapturedTools } from '../actions/capture-handlers.js';
import type { UiActionSurface } from '../store/types.js';
import {
  isUiActionDeviceId,
  UI_ACTION_DEVICE_ID_MAX_LENGTH,
} from '../store/ui-action-device-id.js';
import {
  executeAction,
  executeAudited,
  hashInput,
  type ActionOutcome,
  type ActionRequest,
  type ActionStore,
  type HandlerOutcome,
} from '../actions/execute.js';

import {
  fetchGoalPriorityRows,
  fetchGoalProgressViews,
  type GoalProgressStore,
} from './goal-progress-api.js';
import { readUnreviewed } from '../analytics/session-review.js';
import { log } from '../logger.js';
import type { LiveSignalHub } from '../state/live-signal.js';
import type {
  DeviceSnapshot,
  ActiveSession,
  ActiveSet,
  CompletedSetRecord,
} from '../state/live-state.js';
import {
  LOCAL_USER_ID,
  type StoredDietPhase,
  type StoredSession,
  type StoredPlannedExercise,
  type StoredProgramAssignment,
  type StoredExerciseSetup,
  type StoredPriority,
  type StoredSet,
  type StoredTrainingProfile,
  type StoredTrainingWeek,
  type SetupCard,
} from '../store/types.js';
import {
  completedSetsForExercise,
  resolveRestLength,
  type ResolvedRest,
} from '../analytics/rest-defaults.js';
import { getReferenceSetupCard } from '../analytics/setup-cards.js';
import { exerciseFatigueStop, type FatigueStop } from '../state/velocity-loss-intent.js';
import { findPlannedExerciseForSession } from '../store/planned-exercise-for-session.js';
import { localDate, todayLocal } from '../analytics/training-days.js';
import { resolveCurrentBlock } from '../plan/current-block.js';
import { fetchMesocycle, type MesocycleStore } from './read-models/mesocycle.js';
import { readTopBanner, type BannerStore } from './read-models/banners.js';

/** Default loopback port. Configurable via `VMCP_DASHBOARD_PORT`. */
export const DEFAULT_DASHBOARD_PORT = 7723;
/** Default bind address — loopback only. See module header for rationale. */
export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';
/** Path the SPA is served at. `/` redirects here; `dashboardUrl` ends here. */
export const DASHBOARD_SPA_PATH = '/app';
/** `listen(0)` — let the OS assign a free port. Used by the EADDRINUSE retry. */
const EPHEMERAL_PORT = 0;
/** Hard cap on `?limit=` for `/api/history`. Anything larger is clamped. */
export const HISTORY_MAX_LIMIT = 100;
/** Default `?limit=` for `/api/history` when the query parameter is absent. */
export const HISTORY_DEFAULT_LIMIT = 20;

export interface DashboardServerOptions {
  /** TCP port. Pass `0` for auto-assignment. Defaults to {@link DEFAULT_DASHBOARD_PORT}. */
  port?: number;
  /** Bind address. Defaults to `127.0.0.1` (loopback). */
  host?: string;
  /**
   * On `EADDRINUSE`, retry once on an OS-assigned port instead of rejecting
   * (VW-167). Any idle session that spawned a server first holds 7723, and the
   * session actually driving the bench then got no dashboard at all. A
   * different port beats no dashboard; the caller reports {@link
   * DashboardServerHandle.port}, which is always the real bound port.
   */
  fallbackToEphemeralPort?: boolean;
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
  /**
   * The store slice the dashboard reads. `listSessions` is the only hard
   * requirement; the planning + session-read methods are optional so the server
   * test fakes (and any store build without planning) degrade to a disabled
   * route rather than failing. The real sqlite store supplies all of them, so
   * `hasPlanStore` / `hasSessionStore` pass in production.
   */
  store: {
    listSessions(filter: {
      sort: 'startedAt:desc' | 'startedAt:asc';
      limit: number;
      offset: number;
      exerciseId?: string;
      /** Inclusive/exclusive ISO bounds — the muscle-plan route's calendar-week scope (VW-331). */
      from?: string;
      to?: string;
    }): Promise<StoredSession[]>;
    getPlannedExercisesForTemplate?(templateId: string): Promise<StoredPlannedExercise[]>;
    /** Plan assignments attached to a session — feeds the active-exercise prescription. */
    getAssignmentsForSession?(sessionId: string): Promise<StoredProgramAssignment[]>;
    /**
     * The active exercise's confirmed setup cards (VW-275), read for the
     * `expectedSetupCard` snapshot field. Optional for the same reason the plan
     * methods are — a fake without it degrades to the digest-seeded default
     * (or nothing) rather than failing.
     */
    listExerciseSetups?(filter: {
      userId: string;
      exerciseId: string;
    }): Promise<StoredExerciseSetup[]>;
    /** The declared diet phase covering a window — `history.trend`'s own read (VW-330). */
    getDietPhaseCovering?(
      userId: string,
      from: string,
      to: string,
    ): Promise<StoredDietPhase | undefined>;
    /** Self-reported training background, read for the early-phase flag (VW-330). */
    getTrainingProfile?(userId: string): Promise<StoredTrainingProfile | undefined>;
    /** The action audit trail (VW-502). Optional for the same reason the rest are. */
    claimUiAction?: ActionStore['claimUiAction'];
    completeUiAction?: ActionStore['completeUiAction'];
  } & Partial<DashboardPlanStore> &
    Partial<DashboardSessionStore> &
    Partial<GoalProgressStore>;
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
          /** Feeds the digest-seeded {@link SetupCard} default (VW-275) when nothing is confirmed. */
          cableSetup?: { cablePath: string };
        }
      | undefined;
    /**
     * Catalog browse/search for the plan builder (VW-120). Optional for the same
     * reason `exercises` itself is — a fake without them yields an empty catalog
     * list, never a 500.
     */
    list?(): DashboardCatalogEntry[];
    search?(query: string): DashboardCatalogEntry[];
    byMuscleGroup?(muscleGroup: string): DashboardCatalogEntry[];
  };
  /**
   * Fan-out hub for the derived live signal, feeding the `GET /api/stream` SSE
   * endpoint (VMCP-01.59). Optional so the server test fakes (and any wiring
   * that never opens a telemetry source) can omit it — the stream route still
   * serves a valid, heartbeat-only `text/event-stream` in that case.
   */
  liveSignals?: LiveSignalHub;
  /**
   * Tool schemas and handlers for `POST /api/actions/:name` (VW-502), captured
   * once at boot. Optional so every existing test fake and the preview harness
   * keep working — the action route answers 501 without it, rather than 500.
   */
  actionTools?: CapturedTools;
}

/** Default `?limit=` for `/api/exercises`; the seed catalog is ~30 entries. */
export const CATALOG_DEFAULT_LIMIT = 200;

export interface DashboardServerHandle {
  /** The port the server actually bound to (resolved from `port: 0`). */
  readonly port: number;
  /**
   * The per-boot token every non-GET route requires (VW-500). Minted once per
   * `startDashboardServer` call, so the EADDRINUSE ephemeral-port retry keeps
   * the same one. The SPA reads it from the served `index.html` or from
   * `GET /api/bootstrap`; tests and non-browser callers read it here.
   */
  readonly writeToken: string;
  /** Stop accepting connections and free the port. Idempotent. */
  close(): Promise<void>;
}

/**
 * Start the dashboard HTTP sidecar. Resolves once the server is listening on
 * the resolved port; rejects on bind failure (port-in-use, EACCES, etc.).
 *
 * With `fallbackToEphemeralPort`, an `EADDRINUSE` on the requested port is
 * retried once on an OS-assigned port rather than surfacing (VW-167).
 */
export async function startDashboardServer(
  opts: DashboardServerOptions,
): Promise<DashboardServerHandle> {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  const host = opts.host ?? DEFAULT_DASHBOARD_HOST;
  // Minted before the bind so the ephemeral-port retry below reuses it: a
  // browser tab that survives the fallback must not need a new token.
  const runtime: DashboardRuntime = { startedAt: Date.now(), writeToken: mintWriteToken() };
  try {
    return await listenOnPort(port, host, opts.state, runtime);
  } catch (err) {
    const retryable =
      opts.fallbackToEphemeralPort === true && isAddressInUse(err) && port !== EPHEMERAL_PORT;
    if (!retryable) throw err;
    const handle = await listenOnPort(EPHEMERAL_PORT, host, opts.state, runtime);
    log.warn(dashboardPortFallbackMessage(port, handle.port, host));
    return handle;
  }
}

/**
 * Per-boot facts the request handler needs beyond the live state: the uptime
 * clock and the write token. One object so the handler's arity stops growing.
 */
interface DashboardRuntime {
  readonly startedAt: number;
  readonly writeToken: string;
}

/** One bind attempt: a fresh `http.Server` listening on exactly `port`. */
function listenOnPort(
  port: number,
  host: string,
  state: DashboardServerState,
  runtime: DashboardRuntime,
): Promise<DashboardServerHandle> {
  const server = createServer((req, res) => {
    handleRequest(req, res, state, runtime).catch((err) => {
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
      resolve(makeHandle(server, boundPort, runtime.writeToken));
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
 * Operator-facing explanation for the `EADDRINUSE` fallback (VW-167): the
 * requested port was taken, so this session bound an OS-assigned one instead.
 * Names both ports because the operator's muscle memory (and any stale browser
 * tab) points at the requested one, which now belongs to another server.
 */
export function dashboardPortFallbackMessage(
  requestedPort: number,
  boundPort: number,
  host: string,
): string {
  return (
    `dashboard sidecar could not bind ${host}:${requestedPort} — another process ` +
    `already holds it, so THIS session bound ${host}:${boundPort} instead. Open ` +
    `http://${host}:${boundPort}${DASHBOARD_SPA_PATH}; a dashboard on ` +
    `${host}:${requestedPort} belongs to the OTHER server and will NOT reflect this ` +
    `session's live set data. \`server.health\` reports the URL for this session.`
  );
}

/**
 * Operator-facing explanation for an `EADDRINUSE` dashboard bind failure that
 * even the port-0 fallback could not rescue (VW-167 narrowed this from every
 * port conflict to that residual case). THIS session gets no dashboard, and the
 * dashboard visible on the requested port belongs to the OTHER server. That
 * exact confusion — an operator watching a dead server's dashboard while live
 * set data flowed to a portless one — is the incident VW-68 addresses. Emitted
 * at error level so it can't be mistaken for the routine warn on the
 * deliberately non-fatal bind path.
 */
export function dashboardPortInUseMessage(port: number, host: string): string {
  return (
    `dashboard sidecar could NOT bind ${host}:${port} — another voltras-mcp ` +
    `instance already holds it, and the fallback to an OS-assigned port failed too. ` +
    `THIS session has NO dashboard; any dashboard open on ${host}:${port} belongs to ` +
    `the OTHER server and will NOT reflect this session's live set data. Stop the ` +
    `other instance, or set VMCP_DASHBOARD_PORT to a free port for this session. ` +
    `(VW-68: one shared daemon removes this race.)`
  );
}

function makeHandle(server: Server, port: number, writeToken: string): DashboardServerHandle {
  let closed = false;
  return {
    port,
    writeToken,
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
  runtime: DashboardRuntime,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const rawUrl = req.url ?? '/';
  // The first arg to URL must be a full URL — synth a base because
  // IncomingMessage.url is a path-only string.
  const url = new URL(rawUrl, 'http://localhost');
  const pathname = url.pathname;

  // Mutating plan routes are handled first: they are the only non-GET surface,
  // so everything below can assume a read.
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') {
    // Every write passes the same guard before any route matching, so a new
    // write route cannot be added unguarded (VW-500).
    const rejection = checkWriteRequest(
      {
        host: req.headers.host,
        origin: headerValue(req.headers.origin),
        contentType: req.headers['content-type'],
        token: headerValue(req.headers[WRITE_TOKEN_HEADER]),
      },
      runtime.writeToken,
    );
    if (rejection !== null) {
      sendJson(res, rejection.status, { error: rejection.error, message: rejection.message });
      return;
    }
    const actionMatch = /^\/api\/actions\/([^/]+)$/.exec(pathname);
    if (actionMatch !== null) {
      await handleAction(req, res, state, method, decodeURIComponent(actionMatch[1]));
      return;
    }
    await handlePlanMutation(req, res, state, method, pathname);
    return;
  }

  // The root is what an operator types from memory; the SPA lives at `/app`,
  // and `/` used to answer `{"error":"not_found"}` (VW-167). Exact path only —
  // every other unmatched path keeps its honest 404.
  if (pathname === '/') {
    res.writeHead(302, { Location: DASHBOARD_SPA_PATH });
    res.end();
    return;
  }

  // React SPA (VMCP-01.44), served read-only under `/app` from the vite-built
  // bundle in `dist/spa` — the sole dashboard surface.
  if (pathname === DASHBOARD_SPA_PATH || pathname === `${DASHBOARD_SPA_PATH}/`) {
    serveSpaIndex(res, runtime.writeToken);
    return;
  }
  if (pathname.startsWith(`${DASHBOARD_SPA_PATH}/`)) {
    serveSpaAsset(res, pathname);
    return;
  }
  if (pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      version: VMCP_VERSION,
      uptimeMs: Date.now() - runtime.startedAt,
    });
    return;
  }
  // The SPA's recovery path for its write token (VW-500): a tab left open
  // across a server restart re-reads it here rather than making the human
  // reload. A cross-origin page can SEND this request but cannot read the
  // reply — the sidecar answers with no CORS headers — and `Sec-Fetch-Site`
  // lets us refuse it outright when the browser says it is cross-site.
  if (pathname === '/api/bootstrap') {
    if (!bootstrapFetchSiteAllowed(headerValue(req.headers['sec-fetch-site']))) {
      sendJson(res, 403, { error: 'foreign_origin', message: 'bootstrap is same-origin only' });
      return;
    }
    sendJson(res, 200, { token: runtime.writeToken, version: VMCP_VERSION });
    return;
  }
  if (pathname === '/api/snapshot') {
    sendJson(res, 200, await buildSnapshotWithRev(state));
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
  if (pathname === '/api/session-plan') {
    const plan = await fetchSessionPlan(state);
    sendJson(res, 200, { plan });
    return;
  }
  if (pathname === '/api/exercises') {
    sendJson(res, 200, { exercises: fetchCatalog(state, url) });
    return;
  }
  if (pathname === '/api/plan-tree') {
    await servePlanTree(res, state, url);
    return;
  }
  if (pathname === '/api/muscle-plan') {
    await serveMusclePlan(res, state);
    return;
  }
  if (pathname === '/api/muscle-week') {
    await serveMuscleWeek(res, state, url);
    return;
  }
  if (pathname === '/api/muscle-strength') {
    await serveMuscleStrength(res, state);
    return;
  }
  if (pathname === '/api/muscle-recovery') {
    await serveMuscleRecovery(res, state);
    return;
  }
  if (pathname === '/api/goals') {
    await serveGoals(res, state);
    return;
  }
  if (pathname === '/api/goal-progress') {
    await serveGoalProgress(res, state, url);
    return;
  }
  if (pathname === '/api/banners') {
    await serveBanners(res, state);
    return;
  }
  const summaryMatch = /^\/api\/session-summary\/([^/]+)$/.exec(pathname);
  if (summaryMatch !== null) {
    await serveSessionSummary(res, state, decodeURIComponent(summaryMatch[1]));
    return;
  }
  sendJson(res, 404, { error: 'not_found' });
}

// ── Plan builder + session completion (VW-120) ────────────────────────────

/**
 * True when the wired store carries the whole planning surface. The dashboard
 * state types every planning method as optional (test fakes supply none), so
 * this is the one place that narrows it; routes 501 when it fails rather than
 * throwing on a missing method halfway through a tree walk.
 */
function hasPlanStore(
  store: DashboardServerState['store'],
): store is DashboardServerState['store'] & DashboardPlanStore {
  return (
    typeof store.listTrainingPrograms === 'function' &&
    typeof store.putPlannedExercise === 'function' &&
    typeof store.getPlannedExercise === 'function' &&
    typeof store.getWorkoutTemplate === 'function' &&
    typeof store.getAssignmentsForTemplate === 'function' &&
    typeof store.getAssignmentsForSession === 'function' &&
    typeof store.getPlannedExercisesForTemplate === 'function' &&
    typeof store.deletePlannedExercise === 'function' &&
    typeof store.getTrainingBlocksForProgram === 'function' &&
    typeof store.getTrainingWeeksForBlock === 'function' &&
    typeof store.getWorkoutTemplatesForWeek === 'function' &&
    typeof store.putTrainingProgram === 'function' &&
    typeof store.putTrainingBlock === 'function' &&
    typeof store.putTrainingWeek === 'function' &&
    typeof store.putWorkoutTemplate === 'function' &&
    typeof store.getTrainingProgram === 'function' &&
    typeof store.getLiveBlockSchedule === 'function'
  );
}

/** @see hasPlanStore — same narrowing, for the session-read methods. */
function hasSessionStore(
  store: DashboardServerState['store'],
): store is DashboardServerState['store'] & DashboardSessionStore {
  return (
    typeof store.getSession === 'function' &&
    typeof store.getSetsForSession === 'function' &&
    typeof store.getSetsForExercise === 'function'
  );
}

/** Catalog name lookup handed to the plan read-models. */
function catalogNameLookup(state: DashboardServerState): (id: string) => string | undefined {
  return (id) => state.exercises?.getById(id)?.name;
}

/** The live session's id + exercise, used to flag "training now" in the plan tree. */
function activeSessionContext(state: DashboardServerState): {
  sessionId?: string | undefined;
  exerciseId?: string | undefined;
} {
  for (const [, slot] of state.slots) {
    const session = slot.live.snapshotSession();
    if (session !== undefined) {
      return { sessionId: session.sessionId, exerciseId: session.exerciseId };
    }
  }
  return {};
}

/**
 * `GET /api/exercises` — catalog browse for the plan builder. `?q=` runs the
 * catalog's own free-text search, `?muscle=` its primary-muscle filter, and
 * neither returns everything. Filters compose: `?q=press&muscle=chest` searches
 * then narrows. Returns `[]` (never 500) when no catalog is wired.
 */
function fetchCatalog(state: DashboardServerState, url: URL): DashboardCatalogEntry[] {
  const catalog = state.exercises;
  if (catalog === undefined) return [];
  const query = url.searchParams.get('q')?.trim() ?? '';
  const muscle = url.searchParams.get('muscle')?.trim() ?? '';

  let entries: DashboardCatalogEntry[];
  if (query !== '' && catalog.search !== undefined) {
    entries = catalog.search(query);
  } else if (muscle !== '' && catalog.byMuscleGroup !== undefined) {
    entries = catalog.byMuscleGroup(muscle);
  } else {
    entries = catalog.list?.() ?? [];
  }
  if (muscle !== '' && query !== '') {
    entries = entries.filter((e) => e.muscleGroups.includes(muscle));
  }
  const limit = parsePositiveInt(url.searchParams.get('limit'), CATALOG_DEFAULT_LIMIT);
  return [...entries].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

async function servePlanTree(
  res: ServerResponse,
  state: DashboardServerState,
  url: URL,
): Promise<void> {
  if (!hasPlanStore(state.store)) {
    sendJson(res, 501, { error: 'plan_store_unavailable' });
    return;
  }
  const programId = url.searchParams.get('programId') ?? undefined;
  const tree = await fetchPlanTree(state.store, catalogNameLookup(state), {
    programId,
    active: activeSessionContext(state),
  });
  sendJson(res, 200, tree);
}

/** The active week's plan structure, resolved by `findActiveWeek`. */
interface ActiveWeek {
  week: StoredTrainingWeek;
  templates: MusclePlanTemplateRow[];
}

/**
 * The active training week — the same "first template with no assignment" walk
 * `plan.next_workout` (`plan-tools.ts`) runs, reimplemented here against
 * `DashboardPlanStore` for the same reason `fetchPlanTree` reimplements its own
 * tree walk rather than importing the MCP-bound tool handler (VW-331). The plan
 * in force comes from the shared current-block rule (VW-475): only a current
 * block is walked, and a gap has no active week.
 */
async function findActiveWeek(store: DashboardPlanStore): Promise<ActiveWeek | null> {
  const read = await resolveCurrentBlock(store, todayLocal());
  if (read.program === null || read.state === 'gap' || read.state === 'upcoming') return null;
  const blocks =
    read.state === 'current' && read.block !== null
      ? [read.block]
      : await store.getTrainingBlocksForProgram(read.program.id);
  for (const block of blocks) {
    for (const week of await store.getTrainingWeeksForBlock(block.id)) {
      const templates: MusclePlanTemplateRow[] = [];
      let hasIncomplete = false;
      for (const template of await store.getWorkoutTemplatesForWeek(week.id)) {
        const completed = (await store.getAssignmentsForTemplate(template.id)).length > 0;
        if (!completed) hasIncomplete = true;
        templates.push({ id: template.id, name: template.name, completed });
      }
      if (hasIncomplete) return { week, templates };
    }
  }
  return null;
}

/**
 * Generous cap on sessions fetched for one calendar week — matches the
 * convention `HISTORY_WEEKLY_VOLUME_SESSION_LIMIT` sets in `metrics-tools.ts`.
 */
const MUSCLE_PLAN_SESSION_LIMIT = 200;

/**
 * `GET /api/muscle-plan` (VW-331, B4 of the body-map plan): planned vs done
 * working sets this week per titan muscle group, plus the upcoming planned
 * exercises per muscle, for the active training week. 404s the same shape
 * `/api/session-summary` does when no training week is currently active.
 */
async function serveMusclePlan(res: ServerResponse, state: DashboardServerState): Promise<void> {
  if (!hasPlanStore(state.store) || !hasSessionStore(state.store)) {
    sendJson(res, 501, { error: 'plan_store_unavailable' });
    return;
  }
  const active = await findActiveWeek(state.store);
  if (active === null) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const { week, templates } = active;
  const plannedExercises: StoredPlannedExercise[] = [];
  for (const template of templates) {
    plannedExercises.push(...(await state.store.getPlannedExercisesForTemplate(template.id)));
  }

  const now = new Date();
  const weekStart = startOfCalendarWeekIso(now);
  // Slack past the exact week boundary — `buildMusclePlanView` applies the
  // authoritative filter, so this only needs to not miss a session.
  const queryEnd = new Date(weekStart);
  queryEnd.setUTCDate(queryEnd.getUTCDate() + 8);
  const sessions = await state.store.listSessions({
    sort: 'startedAt:asc',
    limit: MUSCLE_PLAN_SESSION_LIMIT,
    offset: 0,
    from: weekStart,
    to: queryEnd.toISOString(),
  });
  const completedSets: StoredSet[] = [];
  for (const session of sessions) {
    completedSets.push(...(await state.store.getSetsForSession(session.id)));
  }

  const view: MusclePlanView = buildMusclePlanView({
    week,
    templates,
    plannedExercises,
    completedSets,
    catalog: (id) => state.exercises?.getById(id),
    now,
  });
  sendJson(res, 200, view);
}

/**
 * How far back of `lastTrainedAt` the muscle-week route can see. A muscle not
 * trained inside this window reports `lastTrainedAt: null` rather than a date,
 * which is the honest answer for a figure that only dims by staleness.
 */
const MUSCLE_WEEK_LOOKBACK_DAYS = 56;

/** Generous cap on sessions fetched for the lookback window. @see MUSCLE_PLAN_SESSION_LIMIT */
const MUSCLE_WEEK_SESSION_LIMIT = 500;

/**
 * The instant `?weekStart=` names, or `null` when the query parameter is
 * present but unparseable. Absent means now, i.e. the current week.
 */
function parseWeekStartParam(url: URL): Date | null {
  const raw = url.searchParams.get('weekStart');
  if (raw === null || raw === '') return new Date();
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * `GET /api/muscle-week` (VW-329, B2 of the body-map plan): weekly working sets
 * per titan muscle group against the population volume landmarks. `?weekStart=`
 * selects a week by any ISO instant inside it; the default is the current week.
 */
async function serveMuscleWeek(
  res: ServerResponse,
  state: DashboardServerState,
  url: URL,
): Promise<void> {
  if (!hasSessionStore(state.store)) {
    sendJson(res, 501, { error: 'session_store_unavailable' });
    return;
  }
  const now = parseWeekStartParam(url);
  if (now === null) {
    sendJson(res, 400, { error: 'invalid_input', message: 'weekStart is not an ISO date' });
    return;
  }

  const weekStart = startOfCalendarWeekIso(now);
  const from = new Date(weekStart);
  from.setUTCDate(from.getUTCDate() - MUSCLE_WEEK_LOOKBACK_DAYS);
  // Slack past the exact week boundary — `buildMuscleWeekView` applies the
  // authoritative filter, so this only needs to not miss a session.
  const to = new Date(weekStart);
  to.setUTCDate(to.getUTCDate() + 8);
  const sessions = await state.store.listSessions({
    sort: 'startedAt:asc',
    limit: MUSCLE_WEEK_SESSION_LIMIT,
    offset: 0,
    from: from.toISOString(),
    to: to.toISOString(),
  });
  const sets: StoredSet[] = [];
  for (const session of sessions) {
    sets.push(...(await state.store.getSetsForSession(session.id)));
  }

  const view: MuscleWeekView = buildMuscleWeekView({
    sets,
    catalog: (id) => state.exercises?.getById(id),
    now,
  });
  sendJson(res, 200, view);
}

/**
 * How far back the muscle-recovery route can see — the same trailing window
 * `/api/muscle-week` uses. A muscle not trained inside it reports
 * `lastTrainedAt: null`, and a benchmark whose prior session fell outside it
 * reports `reason: 'insufficient history'` rather than a verdict built on a
 * partial view.
 */
const MUSCLE_RECOVERY_LOOKBACK_DAYS = 56;

/** Generous cap on sessions fetched for the lookback window. @see MUSCLE_PLAN_SESSION_LIMIT */
const MUSCLE_RECOVERY_SESSION_LIMIT = 500;

/**
 * `GET /api/muscle-recovery` (VW-332, B5 of the body-map plan): per titan
 * muscle group, when it was last trained, how many days ago, that session's
 * entry-depression read, and whether it matched or beat its previous comparable
 * session. No recovery window is computed — see the read-model's header.
 */
async function serveMuscleRecovery(
  res: ServerResponse,
  state: DashboardServerState,
): Promise<void> {
  if (!hasSessionStore(state.store)) {
    sendJson(res, 501, { error: 'session_store_unavailable' });
    return;
  }
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - MUSCLE_RECOVERY_LOOKBACK_DAYS);
  const sessions = await state.store.listSessions({
    sort: 'startedAt:asc',
    limit: MUSCLE_RECOVERY_SESSION_LIMIT,
    offset: 0,
    from: from.toISOString(),
  });
  const sets: StoredSet[] = [];
  for (const session of sessions) {
    sets.push(...(await state.store.getSetsForSession(session.id)));
  }

  const view: MuscleRecoveryView = buildMuscleRecoveryView({
    sessions,
    sets,
    fatigueBySession: buildFatigueAxesLookup(sets),
    catalog: (id) => state.exercises?.getById(id),
    now,
  });
  sendJson(res, 200, view);
}

/** @see hasPlanStore — same narrowing, for the goal-coach routes (VW-352). */
function hasGoalStore(
  store: DashboardServerState['store'],
): store is DashboardServerState['store'] & GoalProgressStore & MesocycleStore {
  return (
    typeof store.listPriorities === 'function' &&
    typeof store.listGoalTargets === 'function' &&
    typeof store.getTrainingProfile === 'function' &&
    typeof store.listTrainingDayInstants === 'function' &&
    typeof store.getSessionDateSpan === 'function' &&
    typeof store.getTrainingWeeksForBlock === 'function' &&
    typeof store.getDietPhaseCovering === 'function' &&
    typeof store.getTrainingBlock === 'function' &&
    typeof store.getTrainingBlocksForProgram === 'function' &&
    typeof store.listBodyMetrics === 'function' &&
    typeof store.getSetsForExercise === 'function' &&
    typeof store.getBaseline === 'function' &&
    typeof store.chapterStartedAt === 'function' &&
    typeof store.getLiveBlockSchedule === 'function' &&
    typeof store.listTrainingPrograms === 'function' &&
    typeof store.getWorkoutTemplatesForWeek === 'function' &&
    typeof store.getAssignmentsForTemplate === 'function'
  );
}

/** The declared priority named by `id`, or `undefined` for an unknown or retired one. */
async function findGoalPriority(
  store: GoalProgressStore,
  id: string,
): Promise<StoredPriority | undefined> {
  const priorities = await store.listPriorities(LOCAL_USER_ID);
  return priorities.find((priority) => priority.id === id);
}

/**
 * `GET /api/goals` (VW-352, G5 of the goal-coach plan): every declared
 * priority, its accepted targets, and the `buildPriorityRollup` verdict
 * across them, plus `mesocycle`: the dated block the page is in (VW-480),
 * `null` while no block has dates.
 */
async function serveGoals(res: ServerResponse, state: DashboardServerState): Promise<void> {
  if (!hasGoalStore(state.store)) {
    sendJson(res, 501, { error: 'goal_store_unavailable' });
    return;
  }
  const now = new Date();
  const rows = await fetchGoalPriorityRows(state.store, now);
  const mesocycle = await fetchMesocycle(state.store, localDate(now.toISOString()));
  // VW-489: every count on this page excludes unreviewed history, so the page has
  // to be able to say so rather than render an unexplained zero. Server field
  // only — the goals SPA reads it in its own change (PR #454 owns that tree).
  const review = await readUnreviewed(state.store);
  sendJson(res, 200, { priorities: rows, mesocycle, review });
}

/**
 * `GET /api/goal-progress?priorityId=` (VW-352, G5 of the goal-coach plan):
 * `buildGoalProgressView` for every non-retired target under one priority.
 */
async function serveGoalProgress(
  res: ServerResponse,
  state: DashboardServerState,
  url: URL,
): Promise<void> {
  if (!hasGoalStore(state.store)) {
    sendJson(res, 501, { error: 'goal_store_unavailable' });
    return;
  }
  const priorityId = url.searchParams.get('priorityId');
  if (priorityId === null || priorityId === '') {
    sendJson(res, 400, { error: 'invalid_input', message: 'priorityId is required' });
    return;
  }
  const priority = await findGoalPriority(state.store, priorityId);
  if (priority === undefined) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const targets = await fetchGoalProgressViews(state.store, priority, new Date());
  sendJson(res, 200, { targets });
}

/** @see hasPlanStore — same narrowing, for the banner read (VW-504). */
function hasBannerStore(
  store: DashboardServerState['store'],
): store is DashboardServerState['store'] & BannerStore {
  return (
    typeof store.listTrainingPrograms === 'function' &&
    typeof store.getTrainingBlocksForProgram === 'function' &&
    typeof store.getTrainingWeeksForBlock === 'function' &&
    typeof store.getWorkoutTemplatesForWeek === 'function' &&
    typeof store.getAssignmentsForTemplate === 'function' &&
    typeof store.getLiveBlockSchedule === 'function' &&
    typeof store.listTrainingDayInstants === 'function'
  );
}

/**
 * `GET /api/banners` (VW-504): the one banner the wall should show, or `null`.
 * A store without the planning reads has nothing to raise, which is an answer
 * rather than a failure, so this 200s with `null` instead of 501ing.
 */
async function serveBanners(res: ServerResponse, state: DashboardServerState): Promise<void> {
  if (!hasBannerStore(state.store)) {
    sendJson(res, 200, { banner: null });
    return;
  }
  const now = new Date();
  const banner = await readTopBanner(state.store, localDate(now.toISOString()), now.toISOString());
  sendJson(res, 200, { banner });
}

async function serveSessionSummary(
  res: ServerResponse,
  state: DashboardServerState,
  requestedId: string,
): Promise<void> {
  if (!hasPlanStore(state.store) || !hasSessionStore(state.store)) {
    sendJson(res, 501, { error: 'plan_store_unavailable' });
    return;
  }
  const sessionId = await resolveSummarySessionId(state.store, requestedId);
  if (sessionId === undefined) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const summary = await buildSessionSummary(
    { store: state.store, nameOf: catalogNameLookup(state) },
    sessionId,
  );
  if (summary === undefined) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  sendJson(res, 200, summary);
}

/** @see hasPlanStore — same narrowing, for the per-muscle strength reads (VW-330). */
function hasMuscleStrengthStore(
  store: DashboardServerState['store'],
): store is DashboardServerState['store'] & MuscleStrengthStore {
  return (
    typeof store.getSetsForSession === 'function' &&
    typeof store.getSetsForExercise === 'function' &&
    typeof store.getDietPhaseCovering === 'function' &&
    typeof store.getTrainingProfile === 'function'
  );
}

/**
 * `GET /api/muscle-strength` — per titan muscle, its primary exercises with
 * best e1RM, 12-week slope and PR flag (VW-330). Owner-only working sets, one
 * row per side. 501s rather than half-answering when the store cannot serve it.
 */
async function serveMuscleStrength(
  res: ServerResponse,
  state: DashboardServerState,
): Promise<void> {
  if (!hasMuscleStrengthStore(state.store)) {
    sendJson(res, 501, { error: 'strength_store_unavailable' });
    return;
  }
  const view = await fetchMuscleStrength({
    store: state.store,
    catalog: (id) => state.exercises?.getById(id),
    now: new Date(),
  });
  sendJson(res, 200, view);
}

/** Hard cap on a request body, so a runaway client can't buy unbounded memory. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * `POST /api/actions/:name` — the action layer (VW-502).
 *
 * The body is `{ actionId, input, actor?, surface?, flowId?, flowStep? }`. The
 * name is looked up in the allowlist, its tool's own schema validates `input`,
 * and its own handler runs it. An unknown or non-allowlisted name answers 403,
 * never 404: probing the layer reveals nothing about what exists.
 *
 * Only POST. A PATCH or DELETE to this path is a client that has misunderstood
 * the layer, not an action, and it answers 405 rather than being coerced.
 */
async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  state: DashboardServerState,
  method: PlanMutationMethod,
  name: string,
): Promise<void> {
  if (method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed', message: 'actions are POSTed' });
    return;
  }
  if (state.actionTools === undefined || !hasActionStore(state.store)) {
    sendJson(res, 501, { error: 'actions_unavailable' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_input', message: (err as Error).message });
    return;
  }
  const request = readActionRequest(name, body);
  if ('error' in request) {
    sendJson(res, 400, { error: 'invalid_input', message: request.error });
    return;
  }
  const outcome = await executeAction(request, {
    store: state.store,
    tools: state.actionTools,
    now: () => new Date(),
  });
  sendActionOutcome(res, outcome);
}

function sendActionOutcome(res: ServerResponse, outcome: ActionOutcome): void {
  sendJson(res, outcome.status, outcome.body);
}

/**
 * Surfaces a request over HTTP can honestly claim. Both are the human's own
 * browser; `voice` and `telegram` do not reach the server this way.
 *
 * The surface is a LABEL, not an authorization input. It is the client's own
 * assertion and the server cannot check it, so nothing may ever branch on it
 * to decide what a request is allowed to do.
 */
const BROWSER_SURFACES = ['wall', 'phone'] as const;

/** The claimed surface, or `null` when it is not one a browser can be. */
function readBrowserSurface(claimed: unknown): UiActionSurface | null {
  const surface = claimed ?? 'wall';
  return isOneOf(surface, BROWSER_SURFACES) ? surface : null;
}

/**
 * Which display sent this (VW-521). Absent is valid and is the common case: `surface` says
 * `wall`, and more than one wall can stand in one house, so a client that wants its rows
 * tellable apart names itself and one that does not is no worse off than before.
 *
 * A LABEL, exactly as `surface` is. The server cannot check the name and nothing branches
 * on it; the only thing refused here is a string the audit trail could not usefully store.
 */
function readDeviceId(claimed: unknown): { deviceId?: string } | { error: string } {
  if (claimed === undefined || claimed === null) return {};
  if (!isUiActionDeviceId(claimed)) {
    return {
      error:
        `deviceId is up to ${UI_ACTION_DEVICE_ID_MAX_LENGTH} characters of letters, digits, ` +
        `'.', '_', ':' or '-', starting with a letter or digit`,
    };
  }
  return { deviceId: claimed };
}

/**
 * Read the envelope around an action's input. `actionId` is required and has
 * no server-side default: a client that cannot produce one cannot have retry
 * safety, and silently minting one here would hand it a guarantee it does not
 * have.
 *
 * ── Why the actor is not the client's to assert ──────────────────────────
 *
 * A request reaching this route came from a page in a browser on this machine
 * — that is what the VW-500 guard establishes. It is therefore a human tap, and
 * the actor is `user`. The coach and the tick do not arrive this way: they run
 * in-process and call `executeAudited` directly, stamping their own actor
 * there. So a body claiming `actor: 'coach'` is either a confused client or one
 * trying to file a human tap as an agent decision, and it is REFUSED rather
 * than honoured or silently downgraded. Without this the audit trail's actor
 * column would be forgeable by anyone holding the write token, which is a
 * weaker claim than an audit trail should make.
 *
 * The surface stays the client's to say, narrowed to the two browser surfaces:
 * wall and phone are both the owner's own browser and the server cannot tell
 * them apart, so nothing is gained by refusing the distinction and a later
 * read would lose it.
 */
function readActionRequest(
  name: string,
  body: Record<string, unknown>,
): ActionRequest | { error: string } {
  const actionId = body.actionId;
  if (typeof actionId !== 'string' || actionId.trim() === '') {
    return { error: 'actionId is required, and must be a non-empty string' };
  }
  if (body.actor !== undefined && body.actor !== 'user') {
    return {
      error: `an action over HTTP is a human tap and is recorded as 'user'; ${String(
        body.actor,
      )} cannot be claimed`,
    };
  }
  const surface = readBrowserSurface(body.surface);
  if (surface === null) {
    return { error: `a browser action is 'wall' or 'phone', not ${String(body.surface)}` };
  }
  const device = readDeviceId(body.deviceId);
  if ('error' in device) return device;
  return {
    name,
    actionId,
    actor: 'user',
    surface,
    ...device,
    ...(typeof body.flowId === 'string' ? { flowId: body.flowId } : {}),
    ...(typeof body.flowStep === 'string' ? { flowStep: body.flowStep } : {}),
    input: body.input ?? {},
  };
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

/** @see hasPlanStore — same narrowing, for the action audit methods. */
function hasActionStore(
  store: DashboardServerState['store'],
): store is DashboardServerState['store'] & ActionStore {
  return typeof store.claimUiAction === 'function' && typeof store.completeUiAction === 'function';
}

/**
 * Route the plan-builder writes. Every branch resolves to a `plan-api.ts` call;
 * `PlanApiError.code` maps onto the HTTP status (`invalid_input` → 400,
 * `not_found` → 404) so the handlers never hand-roll a response shape.
 */
async function handlePlanMutation(
  req: IncomingMessage,
  res: ServerResponse,
  state: DashboardServerState,
  method: PlanMutationMethod,
  pathname: string,
): Promise<void> {
  const route = matchPlanRoute(method, pathname);
  if (route === null) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  if (!hasPlanStore(state.store)) {
    sendJson(res, 501, { error: 'plan_store_unavailable' });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    sendJson(res, 400, { error: 'invalid_input', message: (err as Error).message });
    return;
  }
  const { store } = state;
  // `actionId` is the audit envelope's, never the plan payload's. Stripped so
  // `plan-api.ts` sees exactly the body it saw before this route was audited.
  const {
    actionId: submittedId,
    surface: submittedSurface,
    deviceId: submittedDeviceId,
    ...payload
  } = body;
  const surface = readBrowserSurface(submittedSurface);
  if (surface === null) {
    sendJson(res, 400, {
      error: 'invalid_input',
      message: `a browser action is 'wall' or 'phone', not ${String(submittedSurface)}`,
    });
    return;
  }
  const device = readDeviceId(submittedDeviceId);
  if ('error' in device) {
    sendJson(res, 400, { error: 'invalid_input', message: device.error });
    return;
  }
  const run = (): Promise<HandlerOutcome> => runPlanRoute(store, route, payload);
  if (!hasActionStore(store)) {
    // No audit table (a test fake, an older store): the write still happens.
    // Degrading to an unaudited write is better than refusing the plan builder,
    // and every real store has the methods.
    sendPlanOutcome(res, await run());
    return;
  }
  const outcome = await executeAudited(
    {
      actionName: PLAN_ROUTE_ACTION_NAMES[route.kind],
      // A client that sends no id gets a minted one, which records the write
      // but buys NO retry safety: a retry mints another id and runs again.
      // The SPA sends its own; see `spa/api-client.ts`.
      actionId: typeof submittedId === 'string' ? submittedId : randomUUID(),
      // Forced, never read from the body: see `readActionRequest`.
      actor: 'user',
      surface,
      ...device,
      inputHash: hashInput({ route: route.kind, id: 'id' in route ? route.id : null, payload }),
      run,
    },
    { store, tools: state.actionTools ?? new Map(), now: () => new Date() },
  );
  // The plan routes keep their ORIGINAL response shape — the plan-api payload,
  // not the action envelope — because the SPA reads it directly and this PR
  // does not change what any route returns.
  sendJson(res, outcome.status, outcome.body.result);
}

/** Audit names for the six plan routes. Not tools, so not in the allowlist. */
const PLAN_ROUTE_ACTION_NAMES: Record<PlanRoute['kind'], string> = {
  createProgram: 'plan.program.create',
  createWorkout: 'plan.workout.create',
  createExercise: 'plan.exercise.create',
  reorderExercises: 'plan.exercise.reorder',
  updateExercise: 'plan.exercise.update',
  deleteExercise: 'plan.exercise.delete',
};

/** Run one plan route, mapping `PlanApiError` onto the status it always had. */
async function runPlanRoute(
  store: DashboardServerState['store'] & DashboardPlanStore,
  route: PlanRoute,
  body: Record<string, unknown>,
): Promise<HandlerOutcome> {
  try {
    switch (route.kind) {
      case 'createProgram':
        return created(await createProgramWithScaffold(store, body));
      case 'createWorkout':
        return created(await createWorkout(store, route.id, body));
      case 'createExercise':
        return created(await createPlannedExercise(store, route.id, body));
      case 'reorderExercises':
        return { ok: true, result: await reorderPlannedExercises(store, route.id, body) };
      case 'updateExercise':
        return { ok: true, result: await updatePlannedExercise(store, route.id, body) };
      case 'deleteExercise':
        return { ok: true, result: await deletePlannedExercise(store, route.id) };
    }
  } catch (err) {
    if (err instanceof PlanApiError) {
      return {
        ok: false,
        code: err.code,
        result: {
          error: err.code,
          message: err.message,
          ...(err.field !== undefined ? { field: err.field } : {}),
        },
        errorStatus: err.code === 'not_found' ? 404 : 400,
      };
    }
    throw err;
  }
}

function created(result: unknown): HandlerOutcome {
  return { ok: true, result, okStatus: 201 };
}

function sendPlanOutcome(res: ServerResponse, outcome: HandlerOutcome): void {
  const status = outcome.ok ? (outcome.okStatus ?? 200) : (outcome.errorStatus ?? 400);
  sendJson(res, status, outcome.result);
}

/** The HTTP verbs the plan-write surface answers. */
export type PlanMutationMethod = 'POST' | 'PATCH' | 'DELETE';

type PlanRoute =
  | { kind: 'createProgram' }
  | {
      kind:
        | 'createWorkout'
        | 'createExercise'
        | 'reorderExercises'
        | 'updateExercise'
        | 'deleteExercise';
      id: string;
    };

/** Path → route match for the six plan-write endpoints. Null means no match. */
function matchPlanRoute(method: PlanMutationMethod, pathname: string): PlanRoute | null {
  const exerciseId = /^\/api\/plan\/exercises\/([^/]+)$/.exec(pathname);
  if (method === 'PATCH') {
    return exerciseId === null
      ? null
      : { kind: 'updateExercise', id: decodeURIComponent(exerciseId[1]) };
  }
  if (method === 'DELETE') {
    return exerciseId === null
      ? null
      : { kind: 'deleteExercise', id: decodeURIComponent(exerciseId[1]) };
  }
  if (pathname === '/api/plan/programs') return { kind: 'createProgram' };
  const workout = /^\/api\/plan\/programs\/([^/]+)\/workouts$/.exec(pathname);
  if (workout !== null) return { kind: 'createWorkout', id: decodeURIComponent(workout[1]) };
  const exercise = /^\/api\/plan\/templates\/([^/]+)\/exercises$/.exec(pathname);
  if (exercise !== null) return { kind: 'createExercise', id: decodeURIComponent(exercise[1]) };
  const reorder = /^\/api\/plan\/templates\/([^/]+)\/reorder$/.exec(pathname);
  if (reorder !== null) return { kind: 'reorderExercises', id: decodeURIComponent(reorder[1]) };
  return null;
}

/**
 * Read and parse a JSON request body. An empty body is `{}` — every write route
 * validates its own required fields, so "missing name" reads the same whether
 * the client sent nothing or sent `{}`.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('request body is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** SSE keepalive cadence (~1 Hz). Doubles as the client's stream-staleness clock. */
const STREAM_HEARTBEAT_MS = 1000;

/**
 * `GET /api/stream` — the VMCP-01.59 Server-Sent Events endpoint. Registers the
 * response as a subscriber on the live-signal hub and streams `phase` /
 * `phaseflip` / `rep` / `set` / `isometric` / `isometric_result` events plus a ~1 Hz
 * `hb` keepalive, in `text/event-stream`.
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
  pushSnapshot(res, state);

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
      pushSnapshot(res, state);
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
 * Fire-and-forget a `snapshot` SSE push. `buildSnapshotWithRev` is async (the
 * VW-275 setup-card lookup), but the stream itself is not — a socket-open
 * callback returns immediately and this write lands whenever the snapshot
 * resolves, same as any other out-of-band push on this connection.
 */
function pushSnapshot(res: ServerResponse, state: DashboardServerState): void {
  void buildSnapshotWithRev(state).then((snapshot) => writeSseEvent(res, 'snapshot', snapshot));
}

/** The synchronous slice of `buildSnapshotWithRev` — everything but the setup-card lookup. */
interface GatheredSnapshotState {
  devices: DeviceEntry[];
  session: ActiveSession | undefined;
  activeSet: SnapshotSet | undefined;
  completedSets: SnapshotCompletedSet[];
  activeExercise: ReturnType<NonNullable<DashboardServerState['exercises']>['getById']>;
  exerciseId: string | undefined;
}

/**
 * Gather the live device/session/set state (and the active exercise's catalog
 * entry) from every slot. Synchronous and side-effect-free over `state.slots`,
 * which is what lets `buildSnapshotWithRev` stamp `rev` immediately after this
 * runs — see its own docstring for why that ordering matters.
 */
function gatherSnapshotState(state: DashboardServerState): GatheredSnapshotState {
  const devices: DeviceEntry[] = [];
  let session: ActiveSession | undefined;
  let activeSet: SnapshotSet | undefined;
  let completedSets: SnapshotCompletedSet[] = [];
  for (const [slotId, slot] of state.slots) {
    // Per-slot sets (VW-71): each slot's OWN active + completed sets ride on its
    // device entry so a bilateral (dual-Voltra) view reads per-limb telemetry. The
    // top-level `sets` below still reports the primary slot's for the single view.
    const device = slot.live.snapshotDevice();
    const liveSet = slot.live.snapshotSet();
    const slotActive = liveSet === undefined ? undefined : withEffort(liveSet, device);
    const slotCompleted = (slot.live.snapshotCompletedSets?.() ?? []).map(recordWithEffort);
    devices.push({
      slotId,
      device,
      sets: { active: slotActive ?? null, completed: slotCompleted },
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
        completedSets = slotCompleted;
      }
    }
    if (activeSet === undefined) {
      activeSet = slotActive;
    }
  }
  const exerciseId = session?.exerciseId;
  const activeExercise =
    exerciseId && state.exercises ? state.exercises.getById(exerciseId) : undefined;
  return { devices, session, activeSet, completedSets, activeExercise, exerciseId };
}

/**
 * The active exercise's reference setup card at exercise start (VW-275).
 * `undefined` with no active exercise, no wired `listExerciseSetups`, or no
 * catalog lookup — the snapshot then shows no card rather than a fabricated one.
 */
async function resolveExpectedSetupCard(
  state: DashboardServerState,
  exerciseId: string | undefined,
): Promise<SetupCard | undefined> {
  if (exerciseId === undefined) return undefined;
  // Bound rather than destructured: `SqliteSessionStore#listExerciseSetups` reads
  // `this.db`, so calling the detached method loses its receiver.
  const listExerciseSetups = state.store.listExerciseSetups?.bind(state.store);
  if (listExerciseSetups === undefined || state.exercises === undefined) return undefined;
  return getReferenceSetupCard({ listExerciseSetups }, state.exercises, {
    userId: LOCAL_USER_ID,
    exerciseId,
  });
}

/**
 * The session's pace against its attached plan (VW-290). `undefined` — and so a
 * null `sessionPace` and a hidden rail footer — whenever there is nothing to
 * estimate from: no session, no planning store wired, or no template attached.
 *
 * Only TEMPLATE assignments are costed, the same ones `fetchSessionPlan`
 * prescribes from: a lone planned-exercise assignment prescribes one exercise,
 * which is not a session's worth of plan to pace against.
 */
async function resolveSessionPace(
  state: DashboardServerState,
  gathered: GatheredSnapshotState,
): Promise<SessionPaceView | undefined> {
  const { session, completedSets } = gathered;
  const { getAssignmentsForSession, getPlannedExercisesForTemplate } = state.store;
  if (session === undefined || !getAssignmentsForSession || !getPlannedExercisesForTemplate) {
    return undefined;
  }
  const assignments = await getAssignmentsForSession.call(state.store, session.sessionId);
  const planned: StoredPlannedExercise[] = [];
  for (const assignment of assignments) {
    if (assignment.workoutTemplateId === undefined) continue;
    planned.push(
      ...(await getPlannedExercisesForTemplate.call(state.store, assignment.workoutTemplateId)),
    );
  }
  const pace = buildSessionPaceView(
    {
      startedAt: session.startedAt,
      nowMs: Date.now(),
      planned,
      completedWorkingSets: countWorkingSets(completedSets),
    },
    state.exercises,
  );
  return pace ?? undefined;
}

/**
 * The active exercise's stop threshold (VW-440) and the rest to count down (VW-441).
 * Rest follows `timer.start`'s rule exactly: the exercise of the last completed set,
 * else the session's, through the same {@link resolveRestLength}.
 */
async function resolveSetGuidance(
  state: DashboardServerState,
  gathered: GatheredSnapshotState,
): Promise<{ fatigueStop: FatigueStop; rest?: ResolvedRest }> {
  const { session, completedSets } = gathered;
  if (session === undefined) return { fatigueStop: exerciseFatigueStop(undefined) };
  const planned = (exerciseId: string | undefined) =>
    exerciseId === undefined
      ? Promise.resolve(undefined)
      : findPlannedForDashboard(state.store, session.sessionId, exerciseId);
  const fatigueStop = exerciseFatigueStop((await planned(session.exerciseId))?.trainingIntent);
  const sets = completedSets.map((record) => record.set);
  const withReps = sets.filter((set) => set.endedAt !== undefined && set.reps.length > 0);
  const restExerciseId = withReps[withReps.length - 1]?.exerciseId ?? session.exerciseId;
  if (restExerciseId === undefined) {
    return { fatigueStop, rest: resolveRestLength({ planned: undefined, exerciseSets: [] }) };
  }
  const rest = resolveRestLength({
    planned: await planned(restExerciseId),
    exerciseSets: completedSetsForExercise(sets, session.exerciseId, restExerciseId),
  });
  return { fatigueStop, rest };
}

/** The shared planned-exercise lookup, when the store slice carries all three reads it needs. */
function findPlannedForDashboard(
  store: DashboardServerState['store'],
  sessionId: string,
  exerciseId: string,
): Promise<StoredPlannedExercise | undefined> {
  const { getAssignmentsForSession, getPlannedExercisesForTemplate, getPlannedExercise } = store;
  if (!getAssignmentsForSession || !getPlannedExercisesForTemplate || !getPlannedExercise) {
    return Promise.resolve(undefined);
  }
  return findPlannedExerciseForSession(
    {
      getAssignmentsForSession: (id) => getAssignmentsForSession.call(store, id),
      getPlannedExercisesForTemplate: (id) => getPlannedExercisesForTemplate.call(store, id),
      getPlannedExercise: (id) => getPlannedExercise.call(store, id),
    },
    sessionId,
    exerciseId,
  );
}

/**
 * Logged sets that advance the plan. Warm-up / probe / technique rungs do not
 * (VW-260), and neither does a 0-rep set — an armed-then-abandoned set the
 * inactivity watchdog force-closed, which the rail already drops from its own
 * "sets done" tally. Counting one would make the two disagree.
 */
function countWorkingSets(completed: readonly CompletedSetRecord[]): number {
  return completed.filter(
    (record) =>
      record.set.reps.length > 0 &&
      (record.set.setPurpose === undefined || record.set.setPurpose === 'working'),
  ).length;
}

/**
 * Monotonic send-order sequence stamped on every snapshot the server hands out —
 * over both `/api/snapshot` (poll) and the `snapshot` SSE push. Assigned
 * synchronously, immediately after {@link gatherSnapshotState} runs and BEFORE
 * the async setup-card lookup — JS is single-threaded, so nothing can interleave
 * between gathering the live state and stamping `rev` for it, and a higher `rev`
 * therefore always reflects live state gathered no earlier. (The setup-card
 * lookup below is the one part of this response NOT captured by that ordering —
 * confirmed setups change far less often than device/session state, so a rare
 * stale card is the acceptable side of that trade.) The client keeps the last
 * `rev` it applied and drops anything not strictly newer, so a slow in-flight
 * poll can never clobber a fresh push (or vice-versa), and the completed-set
 * fold never sees a set boundary twice.
 */
let snapshotRev = 0;

/** The authoritative snapshot plus its ordering stamp — the shape both channels send. */
type RevSnapshot = SnapshotResponse & { rev: number };

async function buildSnapshotWithRev(state: DashboardServerState): Promise<RevSnapshot> {
  const gathered = gatherSnapshotState(state);
  const rev = ++snapshotRev;
  const expectedSetupCard = await resolveExpectedSetupCard(state, gathered.exerciseId);
  const sessionPace = await resolveSessionPace(state, gathered);
  const guidance = await resolveSetGuidance(state, gathered);
  return {
    ...buildSnapshotView({
      ...gathered,
      ...guidance,
      ...(expectedSetupCard !== undefined ? { expectedSetupCard } : {}),
      ...(sessionPace !== undefined ? { sessionPace } : {}),
    }),
    rev,
  };
}

async function fetchHistory(
  state: DashboardServerState,
  url: URL,
): Promise<readonly StoredSession[]> {
  const limit = parseLimit(url.searchParams.get('limit'));
  const sessions = await state.store.listSessions({
    sort: 'startedAt:desc',
    limit,
    offset: 0,
  });
  return buildHistoryView({ sessions });
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
    const title = await resolveSessionTitle(store, assignment.workoutTemplateId);
    const rows: SessionPlanRows = { activeExerciseId: exerciseId, match, planned, title };
    return buildSessionPlanView(rows, state.exercises);
  }
  return null;
}

/**
 * Walk the template → week → block chain (VW-43) and compose the session title.
 * Each hop is optional on the store slice and each lookup can miss — either yields
 * null, never a fabricated title.
 */
async function resolveSessionTitle(
  store: DashboardServerState['store'],
  workoutTemplateId: string,
): Promise<string | null> {
  if (
    store.getWorkoutTemplate === undefined ||
    store.getTrainingWeek === undefined ||
    store.getTrainingBlock === undefined
  ) {
    return null;
  }
  const template = await store.getWorkoutTemplate(workoutTemplateId);
  if (template === undefined) return null;
  const week = await store.getTrainingWeek(template.weekId);
  const block = week === undefined ? undefined : await store.getTrainingBlock(week.blockId);
  return composeSessionTitle({
    templateName: template.name,
    blockName: block?.name,
    focus: block?.focus,
  });
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return HISTORY_DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return HISTORY_DEFAULT_LIMIT;
  if (parsed > HISTORY_MAX_LIMIT) return HISTORY_MAX_LIMIT;
  return parsed;
}

/** `?limit=`-style query parse with no hard cap — absent/invalid falls back to `fallback`. */
function parsePositiveInt(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
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

function serveSpaIndex(res: ServerResponse, writeToken: string): void {
  try {
    const html = readFileSync(join(SPA_DIR, 'index.html'), 'utf8');
    // `sendHtml` already sets `cache-control: no-store`, which is what keeps
    // the token out of a shared cache or a saved page.
    sendHtml(res, 200, injectWriteToken(html, writeToken));
  } catch {
    sendHtml(res, 503, SPA_NOT_BUILT_HTML);
  }
}

/** `node:http` types a repeated header as `string[]`; a repeat is never valid here. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? undefined : raw;
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
