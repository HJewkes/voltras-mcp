/**
 * `#/body` fetch wrapper (VW-338, plan D1).
 *
 * Polls the three `/api/muscle-*` read models at the same cadence the other
 * operator routes use, for the same reason `goals-client.ts` gives: a `set.end`
 * writes derived numbers to sqlite with no live-signal push, so a poll is the
 * only way a set logged during a session reaches this page.
 *
 * State lives in local component state rather than the shared dashboard store —
 * nothing else on the wall reads per-muscle volume.
 */
import React, { useEffect, useState } from 'react';
import { Caption, Spinner, Surface } from '@titan-design/react-ui';

import { fetchMusclePlan, fetchMuscleStrength, fetchMuscleWeek } from './body-client.js';
import { BodyView } from './BodyView.js';
import type { BodyPageData } from './body-model.js';
import { ErrorNote, PAGE_PADDING } from '../planner/PlanBuilderPage.js';
import { PANEL_GAP } from '../planner/PanelCard.js';
import { SPACE } from '../planner/design.js';

const POLL_INTERVAL_MS = 2000;

async function load(): Promise<BodyPageData> {
  const [week, strength, plan] = await Promise.all([
    fetchMuscleWeek(),
    fetchMuscleStrength(),
    fetchMusclePlan(),
  ]);
  return { week, strength, plan };
}

export function BodyPage(): React.JSX.Element {
  const [data, setData] = useState<BodyPageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const loaded = await load();
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
  return <BodyView data={data} />;
}
