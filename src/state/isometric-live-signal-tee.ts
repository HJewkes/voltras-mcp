// Tees `isometric_phase` (VW-198) and `isometric_result` (VW-264) channel events into
// the live-signal hub so the dashboard's existing SSE stream can drive an isometric-hold
// walkthrough and its verdict card without a second push transport. Passthrough is
// byte-identical to the undecorated publisher; the hub itself is a no-op fan-out when
// no dashboard is subscribed (`LiveSignalHub.emit` over an empty listener set).
//
// Mirrors the `CueTeePublisher` shape in `voice/cue-emitter.ts`: decode-then-forward,
// with a failed/foreign decode simply skipped rather than surfaced.

import type { ChannelEvent, ChannelPublisher } from './channel-publisher.js';
import {
  type LiveIsometricPhase,
  type LiveIsometricResultSignal,
  type LiveIsometricSignal,
  type LiveSignalHub,
} from './live-signal.js';

const PHASES: ReadonlySet<string> = new Set(['ready', 'go', 'hold', 'stop']);

/**
 * Decode an `isometric_phase` channel event's `meta` (built by
 * `buildIsometricPhasePayload` in `channel-payloads.ts`) into the live-signal shape.
 * Returns null for every other `event_type` (the tee sees ALL channel events) or a
 * payload missing/malforming a required key — additive by design, so an unrecognised
 * shape is silently ignored rather than breaking the live overlay.
 *
 * `fallbackSlot` is the slot THIS tee instance was scoped to via {@link
 * IsometricLiveTeePublisher.forSlot} — needed because the real caller (`isometric-
 * tools.ts`) publishes through `state.channels.forSlot(slotId)` without setting
 * `meta.slot` itself; the underlying `slotScopedPublisher` only injects it on ITS OWN
 * `inner.publish` call, which happens strictly after this tee has already read `event`,
 * so the tee cannot see that injected value on the event it decodes. An explicit
 * `meta.slot` (defensive — no caller sets one today) still wins.
 */
function decodeIsometricSignal(
  event: ChannelEvent,
  fallbackSlot: string | undefined,
): LiveIsometricSignal | null {
  const { meta } = event;
  if (meta.event_type !== 'isometric_phase') return null;
  if (!PHASES.has(meta.phase)) return null;
  const trial = Number.parseInt(meta.trial, 10);
  const holdMs = Number.parseInt(meta.hold_ms, 10);
  if (!Number.isFinite(trial) || !Number.isFinite(holdMs)) return null;
  const side = meta.side === 'left' || meta.side === 'right' ? meta.side : null;
  const slot = meta.slot !== undefined ? meta.slot : (fallbackSlot ?? 'primary');
  return { slot, phase: meta.phase as LiveIsometricPhase, trial, holdMs, side };
}

/**
 * Decode an `isometric_result` channel event (VW-264) into the live-signal shape.
 *
 * Unlike the phase decoder above this reads the CONTENT rather than `meta`: the payload
 * is a nested object (per-side peaks) and `meta` is flat strings, so re-flattening it
 * there only to re-parse it here would be two lossy conversions instead of one exact
 * one. Same additive posture — anything unrecognised returns null and the wall simply
 * never shows a card.
 */
function decodeIsometricResult(event: ChannelEvent): LiveIsometricResultSignal | null {
  if (event.meta.event_type !== 'isometric_result') return null;
  try {
    const parsed = JSON.parse(event.content) as { isometric_result?: LiveIsometricResultSignal };
    const result = parsed.isometric_result;
    if (result === undefined || !Array.isArray(result.sides)) return null;
    if (typeof result.tool !== 'string' || typeof result.occurredAt !== 'number') return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * Channel publisher decorator that forwards every event to `inner` unchanged, then
 * feeds `isometric_phase` events into the live-signal hub as an `isometric` signal and
 * `isometric_result` events as an `isometric_result` signal.
 */
export class IsometricLiveTeePublisher implements ChannelPublisher {
  constructor(
    private readonly inner: ChannelPublisher,
    private readonly hub: LiveSignalHub,
    /** The slot this instance was scoped to via `forSlot`, or undefined at the root. */
    private readonly slotId?: string,
  ) {}

  publish(event: ChannelEvent): void {
    this.inner.publish(event);
    const signal = decodeIsometricSignal(event, this.slotId);
    if (signal !== null) this.hub.emit({ type: 'isometric', data: signal });
    const result = decodeIsometricResult(event);
    if (result !== null) this.hub.emit({ type: 'isometric_result', data: result });
  }

  forSlot(slotId: string): ChannelPublisher {
    // Slot-scoped sends still tee: wrap the slot-scoped inner with the SAME hub, and
    // remember `slotId` so the decoded signal carries it (see `decodeIsometricSignal`).
    return new IsometricLiveTeePublisher(this.inner.forSlot(slotId), this.hub, slotId);
  }
}

/**
 * Wrap `inner` with the isometric live tee, or return `inner` unchanged when no hub is
 * wired (tests, or a process with the dashboard sidecar disabled — `state.liveSignals`
 * is optional there).
 */
export function installIsometricLiveTee(
  inner: ChannelPublisher,
  hub: LiveSignalHub | undefined,
): ChannelPublisher {
  if (hub === undefined) return inner;
  return new IsometricLiveTeePublisher(inner, hub);
}
