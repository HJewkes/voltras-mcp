/**
 * `#/body` fetch wrapper (VW-338, plan D1).
 *
 * Polls the four `/api/muscle-*` read models at the same cadence the other
 * operator routes use, for the same reason `goals-client.ts` gives: a `set.end`
 * writes derived numbers to sqlite with no live-signal push, so a poll is the
 * only way a set logged during a session reaches this page.
 *
 * State lives in local component state rather than the shared dashboard store —
 * nothing else on the wall reads per-muscle volume.
 */
import React, { useEffect, useState } from 'react';
import { Caption, Spinner, Surface } from '@titan-design/react-ui';

import {
  fetchMusclePlan,
  fetchMuscleRecovery,
  fetchMuscleStrength,
  fetchMuscleWeek,
} from './body-client.js';
import { BodyView } from './BodyView.js';
import { useBodyDrill } from './use-body-drill.js';
import type { BodyPageData } from './body-model.js';
import { ErrorNote, PAGE_PADDING } from '../planner/PlanBuilderPage.js';
import { PANEL_GAP } from '../planner/PanelCard.js';
import { SPACE } from '../planner/design.js';

const POLL_INTERVAL_MS = 2000;

export async function loadBodyPage(): Promise<BodyPageData> {
  const [week, strength, plan, recovery] = await Promise.all([
    fetchMuscleWeek(),
    fetchMuscleStrength(),
    fetchMusclePlan(),
    fetchMuscleRecovery(),
  ]);
  return { week, strength, plan, recovery };
}

/** `muscle` is the route's deep-linked sheet; the drill stack owns it once the page is up. */
export function BodyPage(props: { muscle?: string }): React.JSX.Element {
  const [data, setData] = useState<BodyPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { stack, drill } = useBodyDrill(props.muscle, data);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const loaded = await loadBodyPage();
        if (!cancelled) {
          setData(loaded);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error !== null) {
    return (
      <Surface level="base" style={{ minHeight: '100%', padding: PAGE_PADDING, gap: PANEL_GAP }}>
        <ErrorNote message={error} />
      </Surface>
    );
  }
  if (data === null) {
    return (
      <Surface
        level="base"
        style={{ minHeight: '100%', padding: PAGE_PADDING, alignItems: 'center', gap: SPACE.sm }}
      >
        <Spinner />
        <Caption color="tertiary">Loading body map…</Caption>
      </Surface>
    );
  }
  return <BodyView data={data} stack={stack} drill={drill} />;
}
