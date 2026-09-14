/**
 * HTTP client for the goal-coach routes (VW-355, plan G8').
 *
 * Same "throw on non-2xx" contract as `planner-client.ts` — every function
 * throws so the page's single poll loop writes one `goalsError`. `fetchGoals`
 * and `fetchGoalProgress` are two calls because the server routes are: `/api/goals`
 * lists every declared priority with its ACCEPTED targets and rollup, and
 * `/api/goal-progress?priorityId=` carries the per-target band + actuals the chart
 * needs, which is too much to compute once per priority server-side without a
 * param. The page fetches the list, then one progress call per priority.
 */
import type { GoalProgressView } from '../../read-models/index.js';
import type { GoalPriorityRow } from '../../goal-progress-api.js';

async function json<T>(input: string): Promise<T> {
  const res = await fetch(input, { cache: 'no-store' });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(detail?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchGoalPriorities(): Promise<{ priorities: GoalPriorityRow[] }> {
  return json('/api/goals');
}

export function fetchGoalProgress(priorityId: string): Promise<{ targets: GoalProgressView[] }> {
  return json(`/api/goal-progress?priorityId=${encodeURIComponent(priorityId)}`);
}

/** Every priority's progress views, keyed by `priorityId`. Best-effort per priority. */
export async function fetchAllGoalProgress(
  priorities: readonly GoalPriorityRow[],
): Promise<Record<string, GoalProgressView[]>> {
  const entries = await Promise.all(
    priorities.map(async (row): Promise<[string, GoalProgressView[]]> => {
      try {
        const { targets } = await fetchGoalProgress(row.priority.id);
        return [row.priority.id, targets];
      } catch {
        // One priority's band re-derivation failing (e.g. no matched history yet)
        // must not blank the rest of the page — it just shows nothing for this one.
        return [row.priority.id, []];
      }
    }),
  );
  return Object.fromEntries(entries);
}
