/**
 * SPA live-overlay slice (VMCP-01.59, Phase 2).
 *
 * An `EventSource` consumer for the sidecar's `GET /api/stream` SSE endpoint,
 * layered ALONGSIDE the authoritative 500 ms `/api/snapshot` poll. The poll
 * stays the source of truth for structural state; this slice only adds live
 * phase / velocity smoothness. If the stream never connects (old browser, proxy
 * strips SSE, server predates this build) the slice stays `null` and the UI
 * behaves exactly as it does without it — no structural data lives only here.
 *
 * Smoothing: the native ~11 Hz `phase` frames (~90 ms apart) are interpolated
 * to 60 Hz via requestAnimationFrame — `phaseElapsedMs` advances from the last
 * real frame's anchor by wall-clock delta, re-anchored on each `phase` frame
 * and hard-reset to 0 on `phaseflip`. Commits are capped so this tiny live
 * subtree re-renders at ~20 Hz, not the whole dashboard.
 *
 * NDA: consumes the fitness-units-only SSE schema (`src/state/live-signal.ts`,
 * type-only import) — no protocol bytes, frames, or command codes cross here.
 */
import { useEffect, useRef, useState } from 'react';

import {
  type LivePhase,
  type LivePhaseFlip,
  type LivePhaseSignal,
  type LiveRepSignal,
  type LiveSetSignal,
} from '../../state/live-signal';

/** The live overlay a consumer renders. Null until the first frame arrives. */
export interface LiveModel {
  /** True while frames/heartbeats are flowing; false once the stream goes stale. */
  connected: boolean;
  phase: LivePhase;
  /** Interpolated time-in-phase (ms): last real anchor + RAF wall-clock delta. */
  phaseElapsedMs: number;
  /** Instantaneous velocity, m/s. */
  velocity: number;
  /** Normalized cable extension, 0-600. */
  position: number;
  /** Instantaneous force, lbs. */
  force: number;
  /** 1-based in-progress rep, or null when no set is armed. */
  repInProgress: number | null;
  /** The most recent finalized rep echo, or null. */
  lastRep: LiveRepSignal | null;
}

/** Below this heartbeat gap the stream is treated as stale (poll-only). */
const STALE_MS = 3000;
/** Max live-subtree commit cadence (~20 Hz) — smooth enough, cheap. */
const COMMIT_INTERVAL_MS = 50;

interface Anchor {
  phase: LivePhase;
  elapsedAtAnchorMs: number;
  wallAtAnchorMs: number;
  velocity: number;
  position: number;
  force: number;
  repInProgress: number | null;
}

/**
 * Subscribe to the live SSE overlay. Returns the current {@link LiveModel}, or
 * `null` until the first signal arrives (or forever, if the stream never
 * connects — the graceful poll-only fallback). Safe to mount unconditionally.
 */
export function useLiveStream(): LiveModel | null {
  const [model, setModel] = useState<LiveModel | null>(null);
  const anchorRef = useRef<Anchor | null>(null);
  const lastRepRef = useRef<LiveRepSignal | null>(null);
  const lastActivityRef = useRef<number>(0);
  const lastCommitRef = useRef<number>(0);

  useEffect(() => {
    // EventSource is absent in very old browsers / some test envs — degrade to
    // poll-only silently rather than throwing.
    if (typeof EventSource === 'undefined') return;

    const source = new EventSource('/api/stream');
    let raf = 0;
    let disposed = false;

    const commit = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastCommitRef.current < COMMIT_INTERVAL_MS) return;
      lastCommitRef.current = now;
      const anchor = anchorRef.current;
      const connected = lastActivityRef.current > 0 && now - lastActivityRef.current < STALE_MS;
      if (anchor === null) {
        setModel((prev) => (prev === null ? prev : { ...prev, connected }));
        return;
      }
      setModel({
        connected,
        phase: anchor.phase,
        phaseElapsedMs: anchor.elapsedAtAnchorMs + Math.max(0, now - anchor.wallAtAnchorMs),
        velocity: anchor.velocity,
        position: anchor.position,
        force: anchor.force,
        repInProgress: anchor.repInProgress,
        lastRep: lastRepRef.current,
      });
    };

    const onPhase = (e: MessageEvent<string>): void => {
      const data = JSON.parse(e.data) as LivePhaseSignal;
      lastActivityRef.current = Date.now();
      // Re-anchor to the real frame — kills interpolation drift.
      anchorRef.current = {
        phase: data.phase,
        elapsedAtAnchorMs: data.phaseElapsedMs,
        wallAtAnchorMs: Date.now(),
        velocity: data.velocity,
        position: data.position,
        force: data.force,
        repInProgress: data.repInProgress,
      };
      commit(true);
    };

    const onFlip = (e: MessageEvent<string>): void => {
      const data = JSON.parse(e.data) as LivePhaseFlip;
      lastActivityRef.current = Date.now();
      // Hard-reset the phase clock the instant the phase flips.
      anchorRef.current = {
        ...(anchorRef.current ?? {
          velocity: 0,
          position: 0,
          force: 0,
          repInProgress: data.repIndex,
        }),
        phase: data.to,
        elapsedAtAnchorMs: 0,
        wallAtAnchorMs: Date.now(),
      };
      commit(true);
    };

    const onRep = (e: MessageEvent<string>): void => {
      lastRepRef.current = JSON.parse(e.data) as LiveRepSignal;
      lastActivityRef.current = Date.now();
      commit(true);
    };

    const onSet = (e: MessageEvent<string>): void => {
      const data = JSON.parse(e.data) as LiveSetSignal;
      lastActivityRef.current = Date.now();
      if (data.kind === 'ended') {
        // Clear the live tempo state back to the non-live per-rep-summary mode.
        anchorRef.current = null;
        lastRepRef.current = null;
      }
      commit(true);
    };

    const onHb = (): void => {
      lastActivityRef.current = Date.now();
    };

    source.addEventListener('phase', onPhase);
    source.addEventListener('phaseflip', onFlip);
    source.addEventListener('rep', onRep);
    source.addEventListener('set', onSet);
    source.addEventListener('hb', onHb);
    // EventSource auto-reconnects honoring the server's `retry:` hint; we just
    // let the staleness clock flip `connected` to false in the meantime.
    source.onerror = (): void => commit(true);

    const tick = (): void => {
      if (disposed) return;
      commit();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      source.removeEventListener('phase', onPhase);
      source.removeEventListener('phaseflip', onFlip);
      source.removeEventListener('rep', onRep);
      source.removeEventListener('set', onSet);
      source.removeEventListener('hb', onHb);
      source.close();
    };
  }, []);

  return model;
}

/** Human label for a live phase, for the compact hero readout. */
export function livePhaseLabel(phase: LivePhase): string {
  switch (phase) {
    case 'con':
      return 'Concentric';
    case 'hold':
      return 'Hold';
    case 'ecc':
      return 'Eccentric';
    default:
      return 'Idle';
  }
}
