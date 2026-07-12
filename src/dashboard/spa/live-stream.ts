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
 * Start the live SSE overlay. Opens `EventSource('/api/stream')` and drives an
 * interpolated {@link LiveModel} to `onModel` at ~20 Hz, returning a disposer.
 *
 * Framework-agnostic (was the `useLiveStream` hook; the anchor/lastRep/activity/commit
 * refs are now closure state) so the dashboard store owns the subscription: an effect
 * calls `createLiveStreamController((m) => dashboardStore.getState().setLive(m))`.
 *
 * `onModel` is never called until the first signal arrives; if the stream never connects
 * (old browser, proxy strips SSE, server predates this build) it stays silent — the
 * graceful poll-only fallback. Safe to start unconditionally.
 */
export function createLiveStreamController(onModel: (model: LiveModel) => void): () => void {
  // EventSource is absent in very old browsers / some test envs — degrade to
  // poll-only silently rather than throwing.
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/stream');
  let raf = 0;
  let disposed = false;

  let current: LiveModel | null = null;
  let anchor: Anchor | null = null;
  let lastRep: LiveRepSignal | null = null;
  let lastActivity = 0;
  let lastCommit = 0;

  const commit = (force = false): void => {
    const now = Date.now();
    if (!force && now - lastCommit < COMMIT_INTERVAL_MS) return;
    lastCommit = now;
    const connected = lastActivity > 0 && now - lastActivity < STALE_MS;
    if (anchor === null) {
      // Only the connected flag can change while un-anchored; nothing to emit before
      // the first real frame.
      if (current !== null) {
        current = { ...current, connected };
        onModel(current);
      }
      return;
    }
    current = {
      connected,
      phase: anchor.phase,
      phaseElapsedMs: anchor.elapsedAtAnchorMs + Math.max(0, now - anchor.wallAtAnchorMs),
      velocity: anchor.velocity,
      position: anchor.position,
      force: anchor.force,
      repInProgress: anchor.repInProgress,
      lastRep,
    };
    onModel(current);
  };

  const onPhase = (e: MessageEvent<string>): void => {
    const data = JSON.parse(e.data) as LivePhaseSignal;
    lastActivity = Date.now();
    // Re-anchor to the real frame — kills interpolation drift.
    anchor = {
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
    lastActivity = Date.now();
    // Hard-reset the phase clock the instant the phase flips.
    anchor = {
      ...(anchor ?? {
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
    lastRep = JSON.parse(e.data) as LiveRepSignal;
    lastActivity = Date.now();
    commit(true);
  };

  const onSet = (e: MessageEvent<string>): void => {
    const data = JSON.parse(e.data) as LiveSetSignal;
    lastActivity = Date.now();
    if (data.kind === 'ended') {
      // Clear the live tempo state back to the non-live per-rep-summary mode.
      anchor = null;
      lastRep = null;
    }
    commit(true);
  };

  const onHb = (): void => {
    lastActivity = Date.now();
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
