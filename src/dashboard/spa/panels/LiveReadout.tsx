/**
 * Compact live phase / velocity readout (VMCP-01.59, Phase 2).
 *
 * A deliberately tiny live overlay that slots into the hero's existing
 * `.hero-live-strip` without redesigning it. It subscribes to only the store's
 * `live` slice, so all live (~20 Hz) re-renders stay scoped to this subtree — the
 * rest of the dashboard keeps re-rendering only on the 500 ms poll / 1 s tick.
 * Renders nothing until the stream connects, so with no stream the strip looks
 * exactly as it did before (graceful poll-only fallback).
 *
 * The SSE subscription itself now lives in the store (`createLiveStreamController`,
 * started once by the dashboard controller); this component is a pure selector view.
 */
import { useStore } from 'zustand';

import { dashboardStore } from '../store';
import { livePhaseLabel } from '../live-stream';

export function LiveReadout(): React.JSX.Element | null {
  const live = useStore(dashboardStore, (s) => s.live);
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
