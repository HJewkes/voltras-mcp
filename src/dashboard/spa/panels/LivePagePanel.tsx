/**
 * Feature-flagged mount for the ported north-star live page (VW-38).
 *
 * Opt in with `?live=1`. Off by default: the page is a work-in-progress port whose data
 * gaps (VW-41..52) are still open, so it must not replace the shipped dashboard until it
 * is at least as truthful.
 *
 * SINGLE vs DUAL comes from STATE (VMCP-04.07), not from a hand-typed URL:
 * {@link selectLiveVariant} reads which limb slots are bound off the snapshot, so a second
 * Voltra joining mid-session swaps the page to the diverging stage and a drop swaps it
 * back, with no reload. It is recomputed on every snapshot rather than latched at mount —
 * a latched variant would be wrong at exactly those two moments. `?variant=` survives as a
 * manual override for testing (see `readVariantOverride`).
 *
 * Self-subscribes to the store's `live` slice for the same reason `LiveReadout` does —
 * the SSE overlay writes at ~20 Hz, and reading it through the shell's `useDashboardModel`
 * would re-render every other panel at that rate. The shell passes only the slow slices.
 */
import React from 'react';
import { useStore } from 'zustand';
import { dashboardStore } from '../store';
import { DashboardChrome } from './DashboardChrome';
import { LivePage, type LivePageVariant } from '../live-page/LivePage';
import { ColdBootView } from '../live-page/ColdBootView';
import { mapStoreToDashboardModel } from './live-view';
import { mapStoreToDivergingHeroModel, mapStoreToFatigueModel } from './fatigue-view';
import { selectLiveVariant } from '../live-page/stage-variant';

/**
 * @param variantOverride the URL's manual stage pin, or `null` to select from state.
 */
export function LivePagePanel({
  variantOverride = null,
}: {
  variantOverride?: LivePageVariant | null;
}): React.JSX.Element | null {
  const snapshot = useStore(dashboardStore, (s) => s.snapshot);
  const accumulator = useStore(dashboardStore, (s) => s.accumulator);
  const prescription = useStore(dashboardStore, (s) => s.prescription);
  const live = useStore(dashboardStore, (s) => s.live);
  // The HTTP poll status folds into BOTH the TopBar's per-device connection glyph (VW-67) and
  // the idle stage's connection hint (VW-68), so a sidecar-unreachable / stale poll degrades
  // the dot and flips the empty-state copy rather than showing a false green.
  const status = useStore(dashboardStore, (s) => s.status);
  // The 1 Hz clock (also bumped on every snapshot) — drives the rest stage's count-up
  // between sets. During a live set the `live` slice already re-renders this at ~20 Hz,
  // so the extra subscription only adds ticks while resting, which is when they matter.
  const nowMs = useStore(dashboardStore, (s) => s.nowMs);

  // Which stage this frame shows. Derived from the SAME snapshot every model below reads,
  // so a variant swap and the data that justifies it land in one render — the dual stage
  // is never asked to draw a slot that has already gone, and the single stage it falls
  // back to renders the surviving slot's set rather than a blank frame.
  const variant = selectLiveVariant(snapshot, variantOverride);

  const sources = { snapshot, accumulator, live, prescription, nowMs, pollStatus: status };
  const model = mapStoreToDashboardModel(sources);
  // The diverging dual hero (VMCP-04.05) + the L/R callout, from the same store slices.
  // Only built when the dual variant is mounted. A null SIDE is an unbound slot, so the
  // stage draws an awaiting wing rather than a fabricated one; a null ASYMMETRY means it
  // could not be computed honestly and the callout simply is not drawn.
  const isDual = variant === 'live-dual';
  const hero = isDual ? mapStoreToDivergingHeroModel(sources) : undefined;
  // ONE fatigue model per page, both variants — `LiveFatigueModel` specifies exactly one
  // athlete-level card even with two devices live (the limbs are folded inside the mapper).
  // The single stage renders it in full via `LiveFatiguePanel`; the diverging stage takes
  // only its `asymmetry`, which is the sole genuinely per-limb figure on it.
  const fatigue = mapStoreToFatigueModel(sources);
  const asymmetry = isDual ? (fatigue?.asymmetry ?? null) : null;

  // The shell chrome (SideNav + TopBar, both store-fed) is shared with the planner
  // routes — see `DashboardChrome`. The wall gets `scroll` off: a wall dashboard is
  // exactly one screen, never a scrolling document. On cold boot (no snapshot yet)
  // the mappers have nothing to read, so the chrome falls back to an idle,
  // device-less shell around the ColdBootView (VW-68) rather than a blank viewport.
  return (
    <DashboardChrome route={{ name: 'live' }}>
      {/* Cold boot: no snapshot has landed yet (VW-68) — an honest "connecting" state inside
          the chrome rather than a blank stage. Once the first poll/SSE frame arrives the live
          page mounts. */}
      {model === null ? (
        <ColdBootView />
      ) : (
        <LivePage
          variant={variant}
          model={model}
          hero={hero}
          asymmetry={asymmetry}
          fatigue={fatigue}
        />
      )}
    </DashboardChrome>
  );
}
