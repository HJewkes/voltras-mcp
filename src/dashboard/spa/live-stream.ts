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
 * Slot demux (VW-48 P2): a bilateral session puts TWO Voltras on one stream, and
 * the server stamps every payload with its originating `slot` (`src/state/live-signal.ts`).
 * All interpolation state — anchor, last rep, peak force, commit throttle and the
 * staleness clock — is held per slot in a lazily-grown map, so one arm's motion can
 * never smear onto the other. `onModel` is called once per slot with the slot id.
 * Payloads without a `slot` (a server predating VW-48) fall back to
 * {@link PRIMARY_SLOT}, which is exactly what single-Voltra streams already send.
 *
 * Confidentiality: consumes the fitness-units-only SSE schema (`src/state/live-signal.ts`,
 * type-only import) — no protocol bytes, frames, or command codes cross here.
 */
import {
  type LivePhase,
  type LivePhaseFlip,
  type LivePhaseSignal,
  type LiveRepSignal,
  type LiveSetSignal,
} from '../../state/live-signal';
import { type Snapshot } from './adapter';

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
  /** Peak concentric force this set, lbs. Resets to 0 when the set ends. */
  peakForce: number;
}

/**
 * The slot a single-Voltra (bench) stream reports, and the fallback for payloads
 * that carry no `slot` at all (a server older than VW-48).
 */
export const PRIMARY_SLOT = 'primary';

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
 * Everything the interpolator needs for ONE slot. Held per slot so two arms
 * interpolate, throttle and go stale independently — a shared anchor would
 * re-time one arm's tempo bar off the other arm's frames.
 */
interface SlotState {
  current: LiveModel | null;
  anchor: Anchor | null;
  lastRep: LiveRepSignal | null;
  peakForce: number;
  lastActivity: number;
  lastCommit: number;
}

function createSlotState(): SlotState {
  return {
    current: null,
    anchor: null,
    lastRep: null,
    peakForce: 0,
    lastActivity: 0,
    lastCommit: 0,
  };
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
 *
 * `onSnapshot` (VMCP-03.04) receives the structural `snapshot` push the server sends on
 * every set-lifecycle boundary — wire it to the store's `applySnapshot` so structure
 * updates immediately instead of waiting for the slow reconciliation poll.
 *
 * `onModel`'s second argument is the originating slot ({@link PRIMARY_SLOT} for a
 * single-Voltra stream). Slot-blind consumers may ignore it and behave exactly as before.
 */
export function createLiveStreamController(
  onModel: (model: LiveModel, slot: string) => void,
  onSnapshot?: (snapshot: Snapshot) => void,
): () => void {
  // EventSource is absent in very old browsers / some test envs — degrade to
  // poll-only silently rather than throwing.
  if (typeof EventSource === 'undefined') return () => {};

  const source = new EventSource('/api/stream');
  let raf = 0;
  let disposed = false;

  /**
   * Per-slot interpolation state, grown lazily on a slot's first signal. Insertion
   * order is the order slots first spoke, which is what the derived single-slot
   * accessor in the store falls back to.
   */
  const slots = new Map<string, SlotState>();

  const slotOf = (data: { slot?: string }): string => data.slot ?? PRIMARY_SLOT;

  const stateFor = (slot: string): SlotState => {
    let state = slots.get(slot);
    if (state === undefined) {
      state = createSlotState();
      slots.set(slot, state);
    }
    return state;
  };

  const commitSlot = (slot: string, s: SlotState, force = false): void => {
    const now = Date.now();
    if (!force && now - s.lastCommit < COMMIT_INTERVAL_MS) return;
    s.lastCommit = now;
    const connected = s.lastActivity > 0 && now - s.lastActivity < STALE_MS;
    if (s.anchor === null) {
      // Only the connected flag can change while un-anchored; nothing to emit before
      // the first real frame.
      if (s.current !== null) {
        s.current = { ...s.current, connected };
        onModel(s.current, slot);
      }
      return;
    }
    s.current = {
      connected,
      phase: s.anchor.phase,
      phaseElapsedMs: s.anchor.elapsedAtAnchorMs + Math.max(0, now - s.anchor.wallAtAnchorMs),
      velocity: s.anchor.velocity,
      position: s.anchor.position,
      force: s.anchor.force,
      repInProgress: s.anchor.repInProgress,
      lastRep: s.lastRep,
      peakForce: s.peakForce,
    };
    onModel(s.current, slot);
  };

  const commitAll = (force = false): void => {
    for (const [slot, s] of slots) commitSlot(slot, s, force);
  };

  /**
   * Stream-level liveness (heartbeat, snapshot push) refreshes EVERY known slot:
   * `connected` describes the SSE transport, which both slots share. A slot only
   * looks disconnected once the whole stream stops — preserving the single-slot
   * behaviour where a quiet rest period does not flip `connected` to false.
   */
  const touchAll = (now: number): void => {
    for (const s of slots.values()) s.lastActivity = now;
  };

  const onPhase = (e: MessageEvent<string>): void => {
    const data = JSON.parse(e.data) as LivePhaseSignal;
    const slot = slotOf(data);
    const s = stateFor(slot);
    s.lastActivity = Date.now();
    // Re-anchor to the real frame — kills interpolation drift.
    s.anchor = {
      phase: data.phase,
      elapsedAtAnchorMs: data.phaseElapsedMs,
      wallAtAnchorMs: Date.now(),
      velocity: data.velocity,
      position: data.position,
      force: data.force,
      repInProgress: data.repInProgress,
    };
    commitSlot(slot, s, true);
  };

  const onFlip = (e: MessageEvent<string>): void => {
    const data = JSON.parse(e.data) as LivePhaseFlip;
    const slot = slotOf(data);
    const s = stateFor(slot);
    s.lastActivity = Date.now();
    // Hard-reset the phase clock the instant the phase flips.
    s.anchor = {
      ...(s.anchor ?? {
        velocity: 0,
        position: 0,
        force: 0,
        repInProgress: data.repIndex,
      }),
      phase: data.to,
      elapsedAtAnchorMs: 0,
      wallAtAnchorMs: Date.now(),
    };
    commitSlot(slot, s, true);
  };

  const onRep = (e: MessageEvent<string>): void => {
    const data = JSON.parse(e.data) as LiveRepSignal;
    const slot = slotOf(data);
    const s = stateFor(slot);
    s.lastRep = data;
    s.peakForce = data.peakForceSoFar;
    s.lastActivity = Date.now();
    commitSlot(slot, s, true);
  };

  const onSet = (e: MessageEvent<string>): void => {
    const data = JSON.parse(e.data) as LiveSetSignal;
    const slot = slotOf(data);
    const s = stateFor(slot);
    s.lastActivity = Date.now();
    if (data.kind === 'ended') {
      // Stop the live in-motion tempo bar, but KEEP the terminal rep's stats
      // (lastRep / peakForce) on screen. VW-57 streams the final rep (rep N)
      // immediately before this `ended` signal; the completed-set per-rep
      // summary should stay visible until the next set arms rather than flashing
      // for a single commit. The stale readout is cleared on the next
      // `set started` below.
      s.anchor = null;
    } else if (data.kind === 'started') {
      // A new set arming clears the previous set's final-rep readout.
      s.lastRep = null;
      s.peakForce = 0;
    }
    commitSlot(slot, s, true);
  };

  const onHb = (): void => {
    touchAll(Date.now());
  };

  const onSnapshotEvent = (e: MessageEvent<string>): void => {
    touchAll(Date.now());
    onSnapshot?.(JSON.parse(e.data) as Snapshot);
  };

  source.addEventListener('phase', onPhase);
  source.addEventListener('phaseflip', onFlip);
  source.addEventListener('rep', onRep);
  source.addEventListener('set', onSet);
  source.addEventListener('hb', onHb);
  source.addEventListener('snapshot', onSnapshotEvent);
  // EventSource auto-reconnects honoring the server's `retry:` hint; we just
  // let the staleness clock flip `connected` to false in the meantime.
  source.onerror = (): void => commitAll(true);

  // ONE rAF loop drives every slot: the frame clock is a property of the browser,
  // not of a Voltra. Each slot still interpolates off its own anchor and respects
  // its own commit throttle inside the shared tick.
  const tick = (): void => {
    if (disposed) return;
    commitAll();
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
    source.removeEventListener('snapshot', onSnapshotEvent);
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
