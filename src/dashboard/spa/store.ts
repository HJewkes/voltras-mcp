/**
 * Dashboard client store (VMCP-03.02).
 *
 * Replaces the 13-`useState` `useDashboardModel` god-hook (and the live overlay's
 * own `useState`/`useRef` set) with ONE vanilla zustand store carrying these slices:
 *
 *   - **snapshot** — the authoritative 500 ms `/api/snapshot` poll + the client-side
 *     completed-set fold (`reduceSnapshot`, now the `applySnapshot` action) + the 1 s
 *     staleness tick.
 *   - **historical** — the slow (~15 s) `/api/session-plan` prescription refetch.
 *   - **planner** (VW-120) — the plan-builder tree + exercise catalog and the
 *     session-completion summary, written by `applyPlanner` from the planner
 *     pages' own polls. Plan writes have no SSE channel, so this slice is
 *     poll-only; see `planner/planner-client.ts`. Also carries `plannerBusy`
 *     (VMCP-03.02 part 2), the mutation-in-flight flag every plan-builder
 *     control disables on — written via the dedicated `setPlannerBusy` action,
 *     not `applyPlanner`, since it comes from the mutation latch, not a fetch.
 *   - **live** — the ~20 Hz `/api/stream` SSE overlay (driven by
 *     `createLiveStreamController`, written via `setLive`), demultiplexed per Voltra
 *     slot into `liveBySlot` (VW-48 P2) with `live` kept as the derived single-slot view.
 *   - **displayUnit** (VW-63) — the wall's chosen lbs/kg DISPLAY unit, written via
 *     `setDisplayUnit` and mirrored to `localStorage` so it survives a reload. Never
 *     converts anything itself — every other slice above stays in lbs, and `mass.ts`
 *     is the only place a value is actually rescaled for display.
 *   - **ui** — shell-level state that used to live in `main.tsx`'s own `useState`:
 *     currently just the parsed hash `route`, written via `setRoute` on every
 *     `hashchange`. A store slice rather than a local hook because it is genuinely
 *     shared (the shell chrome and the routed page both need it), not because
 *     anything here polls or streams.
 *
 * The store is framework-agnostic (`zustand/vanilla`) so it is unit-testable headlessly
 * and the I/O orchestration lives in effects that call these actions — no fetch/interval
 * logic in the store. Components read via granular `useStore(dashboardStore, selector)`
 * subscriptions, so a live-slice write re-renders only the live subtree, preserving the
 * old "20 Hz stays scoped to the hero readout" property.
 *
 * The derivation seam (`adapter.ts` + the `*-view.ts` mappers) is untouched — those stay
 * pure and are called as selectors over this store's state.
 *
 * Confidentiality: state here is `/api/snapshot` + fitness-units SSE only — no protocol bytes.
 */
import { createStore } from 'zustand/vanilla';

import {
  initialAccumulatorState,
  reduceSnapshot,
  type AccumulatorState,
  type PrescriptionView,
  type Snapshot,
} from './adapter';
import { type LiveModel } from './live-stream';
import type { LiveIsometricSignal } from '../../state/live-signal';
import { type MassUnit } from './live-page/mass';
import { parseRoute, type Route } from './routing';
import type { DashboardCatalogEntry } from '../read-models/catalog-entry';
import type { PlanTreeView } from '../read-models/plan-tree';
import type { SessionSummaryView } from '../read-models/session-summary-view';

export type Status = 'ok' | 'stale' | 'error';

/**
 * No successful snapshot (poll OR SSE push) within this window ⇒ `stale`. Sized above
 * the 2 s reconciliation poll (VMCP-03.04) so one delayed poll doesn't flash stale;
 * during an active session the ~set-boundary SSE pushes keep it fresh well inside this.
 */
export const STALE_THRESHOLD_MS = 5000;

interface SnapshotSlice {
  snapshot: Snapshot | null;
  accumulator: AccumulatorState;
  status: Status;
  nowMs: number;
  /** Wall-clock of the last successful poll; drives the staleness watchdog. */
  lastSuccessMs: number;
  /** Highest server `rev` applied so far; older/equal snapshots are dropped. */
  lastRev: number | null;
}

interface HistoricalSlice {
  prescription: PrescriptionView | null;
}

/** A best-effort batch of slow-cadence historical results (any subset). */
export type HistoricalPatch = Partial<HistoricalSlice>;

/**
 * The slot a single-Voltra (bench) stream reports; also what the derived {@link
 * LiveSlice.live} accessor prefers.
 */
export const PRIMARY_SLOT = 'primary';

/**
 * Plan-builder + session-completion state (VW-120). A fourth slice on the same
 * store rather than a second state library: these pages poll the same way the
 * live page does, so they get the same "effects call one action, components read
 * granular slices" shape. `plannerError` holds the last fetch/mutation failure
 * so the page can surface it without swallowing the previously loaded tree.
 */
interface PlannerSlice {
  /** The selected program's tree, refreshed on the plan page's poll. */
  planTree: PlanTreeView | null;
  /** Exercise catalog for the browse/search panel. */
  catalog: DashboardCatalogEntry[];
  /** The loaded session-completion summary. */
  sessionSummary: SessionSummaryView | null;
  plannerError: string | null;
  /**
   * True while a plan-builder mutation is in flight (VMCP-03.02 part 2). Read
   * directly by every plan-builder control that disables during a write
   * (`ProgramBar`, `WorkoutList`, `PlannedExerciseRow`) — moved here because
   * `WorkoutEditor` was carrying a `busy` prop solely to forward it to
   * `PlannedExerciseRow`, not because it needed the value itself.
   */
  plannerBusy: boolean;
}

/** A best-effort batch of planner results (any subset), mirroring {@link HistoricalPatch}. */
export type PlannerPatch = Partial<PlannerSlice>;

/** localStorage key for the wall's chosen weight/force display unit (VW-63). */
export const DISPLAY_UNIT_KEY = 'voltras.live.displayUnit';

/**
 * The viewer's chosen DISPLAY unit (VW-63) — independent of the model's source unit,
 * which is always lbs. Persisted to `localStorage` so a wall keeps its unit across
 * reloads; SSR/test envs with no `window` fall back to lbs.
 */
interface DisplayUnitSlice {
  displayUnit: MassUnit;
}

function readStoredDisplayUnit(): MassUnit {
  if (typeof window === 'undefined') return 'lbs';
  return window.localStorage.getItem(DISPLAY_UNIT_KEY) === 'kg' ? 'kg' : 'lbs';
}

/**
 * Shell-level UI state (VMCP-03.02 part 1) — currently just the hash route.
 * SSR/test envs with no `window` fall back to the live route (same default
 * {@link parseRoute} gives an empty/unrecognised hash).
 */
interface UiSlice {
  route: Route;
}

function readInitialRoute(): Route {
  return parseRoute(typeof window === 'undefined' ? '' : (window.location?.hash ?? ''));
}

interface LiveSlice {
  /**
   * Per-slot live overlays, keyed by the slot the SSE payload was stamped with
   * (`'primary'` for a single Voltra, `'left'` / `'right'` bilaterally). A slot
   * appears on its first frame and is removed when its overlay is cleared.
   */
  liveBySlot: Record<string, LiveModel>;
  /**
   * Derived single-slot view for slot-blind consumers: the `primary` overlay when
   * present, else the first slot that spoke. Identical to the pre-demux `live` field
   * for single-Voltra streams, which only ever carry `primary`.
   */
  live: LiveModel | null;
}

/** @see LiveSlice.live */
function deriveLive(bySlot: Record<string, LiveModel>): LiveModel | null {
  return bySlot[PRIMARY_SLOT] ?? Object.values(bySlot)[0] ?? null;
}

/**
 * The current isometric-hold walkthrough (VW-198): per-slot, mirroring {@link LiveSlice}.
 * A slot holds a signal only while a hold is in progress — `stop` clears it (see
 * {@link deriveIsometric}'s caller, `setIsometric`) rather than displaying the terminal
 * phase, so "no panel" reliably means "no hold in progress" for the walkthrough panel.
 */
interface IsometricSlice {
  isometricBySlot: Record<string, LiveIsometricSignal>;
  /** @see LiveSlice.live — same single-slot derivation for slot-blind consumers. */
  isometric: LiveIsometricSignal | null;
}

/** @see IsometricSlice.isometric */
function deriveIsometric(bySlot: Record<string, LiveIsometricSignal>): LiveIsometricSignal | null {
  return bySlot[PRIMARY_SLOT] ?? Object.values(bySlot)[0] ?? null;
}

interface DashboardActions {
  /** Apply a fresh snapshot: fold the completed-set accumulator, mark ok, stamp the clock. */
  applySnapshot(data: Snapshot, now: number): void;
  /** A poll failed — surface the error state (keeps the last-known snapshot). */
  markError(): void;
  /** 1 s tick: advance the count-up clock and flip to `stale` past the watchdog threshold. */
  tick(now: number): void;
  /** Merge a batch of slow-cadence historical results (best-effort; partial is fine). */
  applyHistorical(patch: Partial<HistoricalSlice>): void;
  /**
   * Push the latest live SSE overlay model for one slot (or null to clear that slot).
   * `slot` defaults to {@link PRIMARY_SLOT}, so slot-blind callers are unchanged.
   */
  setLive(live: LiveModel | null, slot?: string): void;
  /**
   * Apply the latest isometric-hold echo for one slot (VW-198), or clear it. `slot`
   * defaults to {@link PRIMARY_SLOT}. A `stop` phase clears the slot rather than storing
   * it — see {@link IsometricSlice}.
   */
  setIsometric(signal: LiveIsometricSignal | null, slot?: string): void;
  /** Merge a batch of planner results (best-effort; partial is fine). */
  applyPlanner(patch: PlannerPatch): void;
  /** Choose the display unit (VW-63) and persist it to `localStorage`. */
  setDisplayUnit(unit: MassUnit): void;
  /** Record a parsed hash route — called from the shell's `hashchange` listener. */
  setRoute(route: Route): void;
  /** Toggle the plan-builder mutation-in-flight flag (VMCP-03.02 part 2). */
  setPlannerBusy(busy: boolean): void;
}

export type DashboardState = SnapshotSlice &
  HistoricalSlice &
  LiveSlice &
  IsometricSlice &
  PlannerSlice &
  DisplayUnitSlice &
  UiSlice &
  DashboardActions;

const initialSnapshot: SnapshotSlice = {
  snapshot: null,
  accumulator: initialAccumulatorState(),
  status: 'ok',
  nowMs: 0,
  lastSuccessMs: 0,
  lastRev: null,
};

const initialHistorical: HistoricalSlice = {
  prescription: null,
};

const initialPlanner: PlannerSlice = {
  planTree: null,
  catalog: [],
  sessionSummary: null,
  plannerError: null,
  plannerBusy: false,
};

export const dashboardStore = createStore<DashboardState>((set) => ({
  ...initialSnapshot,
  ...initialHistorical,
  ...initialPlanner,
  liveBySlot: {},
  live: null,
  isometricBySlot: {},
  isometric: null,
  displayUnit: readStoredDisplayUnit(),
  route: readInitialRoute(),

  applySnapshot: (data, now) =>
    set((state) => {
      // Drop out-of-order snapshots: a stale in-flight poll must not clobber a
      // fresher SSE push (or vice-versa) and re-trigger the completed-set fold.
      // Snapshots without a rev (hand-built/empty) always apply.
      if (data.rev !== undefined && state.lastRev !== null && data.rev <= state.lastRev) {
        return {};
      }
      return {
        snapshot: data,
        // Advance the clock in the same update that may set restStartMs, so the rest
        // count-up reads `now - restStartMs === 0` at the transition (no brief negative).
        accumulator: reduceSnapshot(state.accumulator, data, now),
        status: 'ok',
        nowMs: now,
        lastSuccessMs: now,
        lastRev: data.rev ?? state.lastRev,
      };
    }),

  // Reset the rev guard on an error: a server restart rewinds its rev counter, so
  // after any connection blip the next snapshot (from either channel) must apply.
  markError: () => set({ status: 'error', lastRev: null }),

  tick: (now) =>
    set((state) => {
      const stale = state.lastSuccessMs > 0 && now - state.lastSuccessMs > STALE_THRESHOLD_MS;
      return {
        nowMs: now,
        status: stale ? (state.status === 'error' ? 'error' : 'stale') : state.status,
      };
    }),

  applyHistorical: (patch) => set(patch),

  applyPlanner: (patch) => set(patch),

  setLive: (live, slot = PRIMARY_SLOT) =>
    set((state) => {
      const liveBySlot = { ...state.liveBySlot };
      if (live === null) {
        if (!(slot in liveBySlot)) return {};
        delete liveBySlot[slot];
      } else {
        liveBySlot[slot] = live;
      }
      return { liveBySlot, live: deriveLive(liveBySlot) };
    }),

  setIsometric: (signal, slot = PRIMARY_SLOT) =>
    set((state) => {
      const isometricBySlot = { ...state.isometricBySlot };
      // `stop` (the capture window closing) clears the slot rather than storing the
      // terminal phase — the walkthrough panel hides the instant a hold ends instead of
      // lingering on "stop and release" until the next hold's `ready` overwrites it.
      if (signal === null || signal.phase === 'stop') {
        if (!(slot in isometricBySlot)) return {};
        delete isometricBySlot[slot];
      } else {
        isometricBySlot[slot] = signal;
      }
      return { isometricBySlot, isometric: deriveIsometric(isometricBySlot) };
    }),

  setDisplayUnit: (unit) =>
    set(() => {
      if (typeof window !== 'undefined') window.localStorage.setItem(DISPLAY_UNIT_KEY, unit);
      return { displayUnit: unit };
    }),

  setRoute: (route) => set({ route }),

  setPlannerBusy: (busy) => set({ plannerBusy: busy }),
}));
