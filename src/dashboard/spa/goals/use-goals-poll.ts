/**
 * The `#/goals` poll (VW-355, plan G8'; lifted out of `GoalsPage` by VW-654).
 *
 * Polls `/api/goals` + one `/api/goal-progress` per priority at the same
 * cadence the planner routes use — there is no SSE channel for goal state,
 * same reasoning as `planner-client.ts`: a `set.end` writes derived numbers to
 * sqlite with no live-signal push, so a poll is the only way a PR star shows up
 * after one.
 *
 * State lives in the route rather than the shared dashboard store: the route
 * hands the one result to both the pinned header slot and the page body, and
 * nothing outside `#/goals` reads goal data.
 */
import { useEffect, useState } from 'react';

import { fetchAllGoalProgress, fetchGoalPriorities } from './goals-client.js';
import type { GoalsPageData } from './goals-model.js';

const POLL_INTERVAL_MS = 2000;

export interface GoalsPollState {
  data: GoalsPageData | null;
  error: string | null;
}

/** One `/api/goals` call, then the per-priority progress it names. */
export async function loadGoalsPage(): Promise<GoalsPageData> {
  const { priorities, mesocycle } = await fetchGoalPriorities();
  const progress = await fetchAllGoalProgress(priorities);
  return { priorities, progress, mesocycle };
}

export function useGoalsPoll(): GoalsPollState {
  const [state, setState] = useState<GoalsPollState>({ data: null, error: null });

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const data = await loadGoalsPage();
        if (!cancelled) setState({ data, error: null });
      } catch (err) {
        if (!cancelled) setState((prev) => ({ ...prev, error: (err as Error).message }));
      }
    };
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return state;
}
