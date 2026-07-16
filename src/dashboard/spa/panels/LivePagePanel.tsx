/**
 * Feature-flagged mount for the ported north-star live page (VW-38).
 *
 * Opt in with `?live=1` (add `&variant=live-dual` for the dual PREVIEW). Off by default:
 * the page is a work-in-progress port whose data gaps (VW-41..52) are still open, so it
 * must not replace the shipped dashboard until it is at least as truthful.
 *
 * Self-subscribes to the store's `live` slice for the same reason `LiveReadout` does —
 * the SSE overlay writes at ~20 Hz, and reading it through the shell's `useDashboardModel`
 * would re-render every other panel at that rate. The shell passes only the slow slices.
 */
import React from 'react';
import { useStore } from 'zustand';
import { DashboardShell, defaultNavItems, type SessionState } from '@titan-design/react-ui';
import { dashboardStore } from '../store';
import { buildSessionState, buildTopBarDevices } from '../adapter';
import { LivePage, type LivePageVariant } from '../live-page/LivePage';
import { ColdBootView } from '../live-page/ColdBootView';
import { mapStoreToDashboardModel } from './live-view';

/** Reads the live-page flag off the URL. Absent ⇒ the page is not mounted at all. */
export function readLivePageVariant(search: string): LivePageVariant | null {
  const params = new URLSearchParams(search);
  if (params.get('live') !== '1') return null;
  return params.get('variant') === 'live-dual' ? 'live-dual' : 'live';
}

export function LivePagePanel({ variant }: { variant: LivePageVariant }): React.JSX.Element | null {
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

  const model = mapStoreToDashboardModel({
    snapshot,
    accumulator,
    live,
    prescription,
    nowMs,
    pollStatus: status,
  });

  // REAL shell chrome inputs, sourced from the store — never fixtures. On cold boot (no
  // snapshot yet) the mappers have nothing to read, so the chrome falls back to an idle,
  // device-less shell around the ColdBootView (VW-68) rather than a blank viewport.
  const devices = snapshot ? buildTopBarDevices(snapshot, status) : [];
  const sessionState: SessionState = snapshot ? buildSessionState(snapshot) : 'idle';

  // The page is one react-native-web flex column rooted at `flex: 1`, but it mounts into
  // a bare `#root` div with no height — so every `flex: 1` below would resolve against
  // `auto` and collapse to content height. Pin the viewport here: a wall dashboard is
  // exactly one screen, never a scrolling document.
  return (
    <div style={{ height: '100vh', width: '100vw', display: 'flex', overflow: 'hidden' }}>
      {/* SideNav (single-view; nav is a no-op for now) + TopBar chrome around the live page.
          activeKey pins the Live category; devices + state are the real store-fed inputs. */}
      <DashboardShell
        activeKey="live"
        navItems={defaultNavItems}
        state={sessionState}
        devices={devices}
        subtitle="wall dashboard"
      >
        {/* Cold boot: no snapshot has landed yet (VW-68) — an honest "connecting" state inside
            the chrome rather than a blank stage. Once the first poll/SSE frame arrives the live
            page mounts. */}
        {model === null ? <ColdBootView /> : <LivePage variant={variant} model={model} />}
      </DashboardShell>
    </div>
  );
}
