/**
 * `#/goals` fetch wrapper (VW-355, plan G8').
 *
 * Polls `/api/goals` + one `/api/goal-progress` per priority at the same
 * cadence the planner routes use (`PLANNER_POLL_INTERVAL_MS`) — there is no
 * SSE channel for goal state, same reasoning as `planner-client.ts`: a
 * `set.end` writes derived numbers to sqlite with no live-signal push, so a
 * poll is the only way a PR star shows up after one.
 *
 * State lives in local component state rather than the shared dashboard
 * store: nothing else on the page reads goal data, so there is no cross-route
 * sharing this needs.
 */
import React, { useEffect, useState } from 'react';
import { Caption, Spinner, Surface } from '@titan-design/react-ui';

import { fetchAllGoalProgress, fetchGoalPriorities } from './goals-client.js';
import { GoalsView } from './GoalsView.js';
import type { GoalsPageData } from './goals-model.js';
import { ErrorNote, PAGE_PADDING } from '../planner/PlanBuilderPage.js';
import { PANEL_GAP } from '../planner/PanelCard.js';
import { SPACE } from '../planner/design.js';

const POLL_INTERVAL_MS = 2000;

async function load(): Promise<GoalsPageData> {
  const { priorities } = await fetchGoalPriorities();
  const progress = await fetchAllGoalProgress(priorities);
  return { priorities, progress };
}

export function GoalsPage(): React.JSX.Element {
  const [data, setData] = useState<GoalsPageData | null>(null);
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
        <Caption color="tertiary">Loading goals…</Caption>
      </Surface>
    );
  }
  return <GoalsView data={data} />;
}
