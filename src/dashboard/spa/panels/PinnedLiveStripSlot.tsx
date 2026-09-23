/**
 * The pinned live strip as the chrome mounts it (VW-429).
 *
 * Self-subscribes to the slices {@link mapStoreToLiveStrip} reads so the 1 Hz rest clock
 * re-renders only this row, never the routed page beneath it. The SSE `live` overlay is
 * deliberately NOT read: the strip's fields come from the snapshot, and a 20 Hz subscription
 * here would re-render the row for nothing.
 */
import React from 'react';
import { useStore } from 'zustand';
import { PinnedLiveStrip } from '@titan-design/react-ui';

import { PAGE_PADDING } from '../planner/PlanBuilderPage';
import { dashboardStore } from '../store';
import { routeHash, type Route } from '../routing';
import { mapStoreToLiveStrip } from './live-strip-view';

const LIVE_HASH = routeHash({ name: 'live' });

export function PinnedLiveStripSlot({ route }: { route: Route }): React.JSX.Element | null {
  const snapshot = useStore(dashboardStore, (s) => s.snapshot);
  const accumulator = useStore(dashboardStore, (s) => s.accumulator);
  const prescription = useStore(dashboardStore, (s) => s.prescription);
  const nowMs = useStore(dashboardStore, (s) => s.nowMs);
  const displayUnit = useStore(dashboardStore, (s) => s.displayUnit);

  const strip = mapStoreToLiveStrip(
    { snapshot, accumulator, prescription, nowMs, displayUnit, live: null },
    route,
  );
  if (strip === null) return null;
  // Inset on the page's own gutter so the strip lines up with the content beneath it.
  return (
    <div style={{ padding: `${PAGE_PADDING}px ${PAGE_PADDING}px 0` }}>
      <PinnedLiveStrip
        {...strip}
        onPress={() => {
          window.location.hash = LIVE_HASH;
        }}
      />
    </div>
  );
}
