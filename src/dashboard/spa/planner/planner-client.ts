/**
 * HTTP client for the plan-builder + session-completion routes (VW-120).
 *
 * ── Why polling, not SSE ──────────────────────────────────────────────────
 *
 * `/api/stream` carries DERIVED LIVE SIGNALS — phase / rep / set boundaries —
 * emitted by the telemetry pipeline. A `plan.exercise.create` MCP call writes to
 * sqlite and produces no such signal, so subscribing would show nothing. The
 * live page already treats `/api/snapshot` polling as its correctness backstop;
 * the plan tree uses the same mechanism at the same cadence as its ONLY channel,
 * which is what makes an agent's writes appear on the builder within ~2 s with
 * no new server-side plumbing.
 *
 * Every function throws on a non-2xx so the caller writes one `plannerError`.
 */
import type { DashboardCatalogEntry } from '../../read-models/catalog-entry';
import type { PlanTreeView } from '../../read-models/plan-tree';
import type { SessionSummaryView } from '../../read-models/session-summary-view';

/** Cadence of the plan-tree poll. Matches the live page's reconciliation poll. */
export const PLANNER_POLL_INTERVAL_MS = 2000;

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, { cache: 'no-store', ...init });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(detail?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function post<T>(url: string, body: unknown): Promise<T> {
  return json<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function fetchPlanTree(programId?: string | null): Promise<PlanTreeView> {
  const query =
    programId === undefined || programId === null
      ? ''
      : `?programId=${encodeURIComponent(programId)}`;
  return json<PlanTreeView>(`/api/plan-tree${query}`);
}

export async function fetchCatalog(
  query: string,
  muscle: string,
): Promise<DashboardCatalogEntry[]> {
  const params = new URLSearchParams();
  if (query !== '') params.set('q', query);
  if (muscle !== '') params.set('muscle', muscle);
  const suffix = params.toString();
  const body = await json<{ exercises: DashboardCatalogEntry[] }>(
    `/api/exercises${suffix === '' ? '' : `?${suffix}`}`,
  );
  return body.exercises;
}

export function fetchSessionSummary(sessionId: string): Promise<SessionSummaryView> {
  return json<SessionSummaryView>(`/api/session-summary/${encodeURIComponent(sessionId)}`);
}

export function createProgram(body: { name: string; workoutName?: string }): Promise<unknown> {
  return post('/api/plan/programs', body);
}

export function createWorkout(programId: string, body: { name: string }): Promise<unknown> {
  return post(`/api/plan/programs/${encodeURIComponent(programId)}/workouts`, body);
}

/** Target fields the builder lets a human set by hand. All optional but `exerciseId`. */
export interface PlannedExerciseInput {
  exerciseId: string;
  targetSets?: number;
  targetRepsLow?: number;
  targetRepsHigh?: number;
  targetWeightLbs?: number;
  restSec?: number;
}

export function addPlannedExercise(
  templateId: string,
  body: PlannedExerciseInput,
): Promise<unknown> {
  return post(`/api/plan/templates/${encodeURIComponent(templateId)}/exercises`, body);
}

export function reorderPlannedExercises(
  templateId: string,
  plannedExerciseIds: string[],
): Promise<unknown> {
  return post(`/api/plan/templates/${encodeURIComponent(templateId)}/reorder`, {
    plannedExerciseIds,
  });
}

export function updatePlannedExercise(
  plannedExerciseId: string,
  patch: Omit<PlannedExerciseInput, 'exerciseId'>,
): Promise<unknown> {
  return json(`/api/plan/exercises/${encodeURIComponent(plannedExerciseId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}
