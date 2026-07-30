/**
 * Dashboard client store (VMCP-03.02).
 *
 * Replaces the 13-`useState` `useDashboardModel` god-hook (and the live overlay's
 * own `useState`/`useRef` set) with ONE vanilla zustand store carrying three slices:
 *
 *   - **snapshot** — the authoritative 500 ms `/api/snapshot` poll + the client-side
 *     completed-set fold (`reduceSnapshot`, now the `applySnapshot` action) + the 1 s
 *     staleness tick.
 *   - **historical** — the slow (~15 s) `/api/session-plan` prescription refetch.
 *   - **planner** (VW-120) — the plan-builder tree + exercise catalog and the
 *     session-completion summary, written by `applyPlanner` from the planner
 *     pages' own polls. Plan writes have no SSE channel, so this slice is
 *     poll-only; see `planner/planner-client.ts`.
 *   - **live** — the ~20 Hz `/api/stream` SSE overlay (driven by
 *     `createLiveStreamController`, written via `setLive`), demultiplexed per Voltra
 *     slot into `liveBySlot` (VW-48 P2) with `live` kept as the derived single-slot view.
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
}

/** A best-effort batch of planner results (any subset), mirroring {@link HistoricalPatch}. */
export type PlannerPatch = Partial<PlannerSlice>;

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
  /** Merge a batch of planner results (best-effort; partial is fine). */
  applyPlanner(patch: PlannerPatch): void;
}

export type DashboardState = SnapshotSlice &
  HistoricalSlice &
  LiveSlice &
  PlannerSlice &
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
};

export const dashboardStore = createStore<DashboardState>((set) => ({
  ...initialSnapshot,
  ...initialHistorical,
  ...initialPlanner,
  liveBySlot: {},
  live: null,

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
}));
