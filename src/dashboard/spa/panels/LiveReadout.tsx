/**
 * Compact live phase / velocity readout (VMCP-01.59, Phase 2).
 *
 * A deliberately tiny, self-contained live overlay that slots into the hero's
 * existing `.hero-live-strip` without redesigning it. It owns the `useLiveStream`
 * SSE subscription, so all live (~20 Hz) re-renders stay scoped to this subtree
 * — the rest of the dashboard keeps re-rendering only on the 500 ms poll / 1 s
 * tick. Renders nothing until the stream connects, so with no stream the strip
 * looks exactly as it did before (graceful poll-only fallback).
 *
 * A navigation-shell redesign is coming separately; this slice is intentionally
 * kept cleanly separable (one component + one hook) so it lifts out easily.
 */
import { livePhaseLabel, useLiveStream } from '../live-stream';

export function LiveReadout(): React.JSX.Element | null {
  const live = useLiveStream();
  if (live === null || !live.connected) return null;

  return (
    <>
      <span className="hero-live-item hero-live-stream" aria-label="live movement phase">
        <b>{livePhaseLabel(live.phase)}</b>
      </span>
      <span className="hero-live-item hero-live-stream" aria-label="live velocity">
        <b>{live.velocity.toFixed(2)}</b> m/s
      </span>
    </>
  );
}
