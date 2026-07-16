// Derived live-signal schema + fan-out for the dashboard realtime transport
// (VMCP-01.59, Phase 0). This is the ONE place the derived per-sample signal
// shape is defined; the SSE endpoint (`GET /api/stream`) and the SPA client
// consume these exact types, and VMCP-02.58's Tier-1 in-process cue matcher is
// intended to consume the SAME derivation off the SAME `event-bridge.ts`
// `onFrame` tap — same fields, derived once. Keep this module free of SDK /
// node imports so the browser SPA can `import type` the schema without pulling
// server code into the bundle.
//
// ── Confidentiality boundary (NF-07) ──────────────────────────────────────
//
// Everything here is expressed in fitness units only: velocity in m/s, force
// in lbs, position as the normalized 0-600 cable extension, and a semantic
// movement phase (`idle` / `con` / `hold` / `ecc`). No protocol bytes, frame
// buffers, or command codes ever appear on this signal — the derivation
// upstream converts at the boundary before handing values here.

/** Semantic movement phase, fitness-facing (never a protocol byte). */
export type LivePhase = 'idle' | 'con' | 'hold' | 'ecc';

/**
 * Map the workout-analytics / SDK numeric movement-phase index onto the
 * fitness-facing {@link LivePhase} label. These indices are semantic phase
 * identities (idle / concentric / hold / eccentric), not raw protocol bytes.
 * Anything unrecognised (including the `-1` UNKNOWN sentinel, which the bridge
 * already drops upstream) collapses to `idle`.
 */
export function mapPhase(code: number): LivePhase {
  switch (code) {
    case 1:
      return 'con';
    case 2:
      return 'hold';
    case 3:
      return 'ecc';
    default:
      return 'idle';
  }
}

/** Convert workout-analytics' native mm/s velocity into m/s for the wire. */
export function mmsToMps(mms: number): number {
  return Number((mms / 1000).toFixed(3));
}

/** Convert a millimetre range-of-motion into metres for the wire. */
export function mmToM(mm: number): number {
  return Number((mm / 1000).toFixed(3));
}

/**
 * A single derived per-sample live signal, emitted at the native frame cadence
 * (~11 Hz, safety-capped at ~20 Hz). `phaseElapsedMs` is the wall-clock time
 * spent in the current phase so far (monotonic within a phase, reset to 0 on a
 * phase flip) — the load-bearing input a live tempo bar interpolates against.
 */
export interface LivePhaseSignal {
  /** Frame timestamp, ms since epoch. */
  t: number;
  phase: LivePhase;
  /** Elapsed time in the current phase, ms. Resets to 0 on each phase flip. */
  phaseElapsedMs: number;
  /** Normalized cable extension, 0 (rest) – 600 (full pull). */
  position: number;
  /** Instantaneous movement velocity, m/s. */
  velocity: number;
  /** Instantaneous force, lbs. */
  force: number;
  /** 1-based index of the rep currently in progress, or null when no set is armed. */
  repInProgress: number | null;
}

/**
 * Emitted the instant the phase byte flips, ahead of the next `phase` frame, so
 * a client can snap its tempo bar and reset its phase clock without waiting up
 * to ~90 ms for the next sample.
 */
export interface LivePhaseFlip {
  t: number;
  from: LivePhase;
  to: LivePhase;
  repIndex: number | null;
}

/** Echo of a finalized rep (mirrors the channel `rep_finalized`, lean shape). */
export interface LiveRepSignal {
  /** 1-based rep number. */
  repIndex: number;
  /** Mean concentric velocity, m/s. */
  vCon: number;
  /** Concentric range of motion, m. */
  rom: number;
  /** Peak concentric velocity, m/s. */
  peakVelocity: number;
  /** Peak CONCENTRIC force observed in the set so far (through this rep), lbs. */
  peakForceSoFar: number;
}

/** Set lifecycle echo so a client can reset / clear its live tempo bar. */
export interface LiveSetSignal {
  kind: 'started' | 'ended';
  setId: string;
  sessionId: string;
  /** Prescribed rep target when known (absent today — reserved for plan wiring). */
  targetReps?: number;
  /** Prescribed tempo string (e.g. "3-1-2") when known (absent today). */
  tempo?: string;
}

/** Discriminated union of everything the live-signal hub fans out. */
export type LiveSignalEvent =
  | { type: 'phase'; data: LivePhaseSignal }
  | { type: 'phaseflip'; data: LivePhaseFlip }
  | { type: 'rep'; data: LiveRepSignal }
  | { type: 'set'; data: LiveSetSignal };

export type LiveSignalListener = (event: LiveSignalEvent) => void;

/**
 * Process-local publish/subscribe registry for derived live signals. The
 * bridge publishes; the SSE endpoint (and, later, 02.58's local matcher)
 * subscribe. Multi-subscriber-safe: a throwing listener is isolated so one bad
 * consumer can't starve the others or wedge the hot frame path.
 */
export class LiveSignalHub {
  private readonly listeners = new Set<LiveSignalListener>();

  subscribe(listener: LiveSignalListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: LiveSignalEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving subscriber must not break the frame path or its peers.
      }
    }
  }

  get subscriberCount(): number {
    return this.listeners.size;
  }
}

/**
 * The ~90 ms native frame cadence renders fine, so this cap is a no-op safety
 * valve today; it only engages if a future firmware/SDK raises the frame rate
 * above ~20 Hz, keeping the wire (and the browser) from being flooded. Phase
 * flips are NEVER throttled — they always pass through instantly.
 */
export const MIN_PHASE_INTERVAL_MS = 50;

/** Pre-mapped, fitness-unit input to the phase clock (no protocol data). */
export interface LiveFrameInput {
  /** Frame timestamp, ms since epoch. */
  t: number;
  phase: LivePhase;
  /** Normalized cable extension, 0-600. */
  position: number;
  /** Instantaneous velocity, m/s. */
  velocity: number;
  /** Instantaneous force, lbs. */
  force: number;
  repInProgress: number | null;
}

/**
 * Live phase-clock: the ~10-line derivation at the heart of Phase 0. Tracks the
 * current phase and when it started so it can stamp `phaseElapsedMs` on every
 * sample and detect phase flips. Pure state machine — one instance per slot,
 * fed each classified frame in order.
 */
export class PhaseClock {
  private phase: LivePhase | null = null;
  private phaseStartedAtMs = 0;

  advance(input: LiveFrameInput): { phase: LivePhaseSignal; flip: LivePhaseFlip | null } {
    let flip: LivePhaseFlip | null = null;
    if (this.phase === null) {
      // First observed frame: seed the clock, no flip (nothing to flip from).
      this.phase = input.phase;
      this.phaseStartedAtMs = input.t;
    } else if (input.phase !== this.phase) {
      flip = { t: input.t, from: this.phase, to: input.phase, repIndex: input.repInProgress };
      this.phase = input.phase;
      this.phaseStartedAtMs = input.t;
    }
    const phaseElapsedMs = Math.max(0, input.t - this.phaseStartedAtMs);
    return {
      phase: {
        t: input.t,
        phase: input.phase,
        phaseElapsedMs,
        position: input.position,
        velocity: input.velocity,
        force: input.force,
        repInProgress: input.repInProgress,
      },
      flip,
    };
  }
}

/**
 * Per-slot emitter that wraps a {@link PhaseClock} + the ~20 Hz safety throttle
 * and fans derived signals into a {@link LiveSignalHub}. The bridge constructs
 * one per slot and calls `frame()` at the `onFrame` choke point; `rep()` /
 * `set()` are thin pass-throughs for the coarser lifecycle echoes.
 */
export class LiveSignalEmitter {
  private readonly clock = new PhaseClock();
  private lastPhaseEmitMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly hub: LiveSignalHub,
    private readonly minPhaseIntervalMs: number = MIN_PHASE_INTERVAL_MS,
  ) {}

  frame(input: LiveFrameInput): void {
    const { phase, flip } = this.clock.advance(input);
    // A flip always fires immediately — it's the crisp phase boundary the
    // client snaps to. Never throttled.
    if (flip !== null) {
      this.hub.emit({ type: 'phaseflip', data: flip });
    }
    if (input.t - this.lastPhaseEmitMs >= this.minPhaseIntervalMs) {
      this.lastPhaseEmitMs = input.t;
      this.hub.emit({ type: 'phase', data: phase });
    }
  }

  rep(data: LiveRepSignal): void {
    this.hub.emit({ type: 'rep', data });
  }

  set(data: LiveSetSignal): void {
    this.hub.emit({ type: 'set', data });
  }
}
