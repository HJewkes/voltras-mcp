/**
 * Dashboard client store (VMCP-03.02).
 *
 * Replaces the 13-`useState` `useDashboardModel` god-hook (and the live overlay's
 * own `useState`/`useRef` set) with ONE vanilla zustand store carrying three slices:
 *
 *   - **snapshot** — the authoritative 500 ms `/api/snapshot` poll + the client-side
 *     completed-set fold (`reduceSnapshot`, now the `applySnapshot` action) + the 1 s
 *     staleness tick.
 *   - **historical** — the slow (~15 s) 8-endpoint fan-out (trend / plan / program / …).
 *   - **live** — the ~20 Hz `/api/stream` SSE overlay (driven by
 *     `createLiveStreamController`, written via `setLive`).
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
import type { NextWorkoutView } from './panels/ExerciseHeroPanel';
import type { ExerciseTrendPoint, PrRecordView } from './panels/StrengthTrendPanel';
import type { ProgramStatusView } from './panels/MesoStatusPanel';
import type { CapacityBandPoint } from './panels/capacity-band-view';
import type { MesoOverviewView } from './panels/meso-overview-view';

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
  lastUpdate: string;
  nowMs: number;
  /** Wall-clock of the last successful poll; drives the staleness watchdog. */
  lastSuccessMs: number;
  /** Highest server `rev` applied so far; older/equal snapshots are dropped. */
  lastRev: number | null;
}

interface HistoricalSlice {
  trend: ExerciseTrendPoint[];
  nextWorkout: NextWorkoutView | null;
  prescription: PrescriptionView | null;
  program: ProgramStatusView | null;
  muscleVolume: Record<string, number>;
  prRecords: PrRecordView[];
  capacityBand: CapacityBandPoint[];
  meso: MesoOverviewView | null;
}

/** A best-effort batch of slow-cadence historical results (any subset). */
export type HistoricalPatch = Partial<HistoricalSlice>;

interface LiveSlice {
  live: LiveModel | null;
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
  /** Push the latest live SSE overlay model (or null when the stream is absent/cleared). */
  setLive(live: LiveModel | null): void;
}

export type DashboardState = SnapshotSlice & HistoricalSlice & LiveSlice & DashboardActions;

function formatClock(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const initialSnapshot: SnapshotSlice = {
  snapshot: null,
  accumulator: initialAccumulatorState(),
  status: 'ok',
  lastUpdate: '—',
  nowMs: 0,
  lastSuccessMs: 0,
  lastRev: null,
};

const initialHistorical: HistoricalSlice = {
  trend: [],
  nextWorkout: null,
  prescription: null,
  program: null,
  muscleVolume: {},
  prRecords: [],
  capacityBand: [],
  meso: null,
};

export const dashboardStore = createStore<DashboardState>((set) => ({
  ...initialSnapshot,
  ...initialHistorical,
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
        lastUpdate: formatClock(new Date(now)),
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

  setLive: (live) => set({ live }),
}));
