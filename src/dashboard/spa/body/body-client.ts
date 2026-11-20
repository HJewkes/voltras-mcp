/**
 * HTTP client for the `#/body` wall page (VW-338, plan D1).
 *
 * Same "throw on non-2xx" contract as `goals-client.ts`, with one exception.
 * `/api/muscle-plan` answers `null` when no training week is active (VW-948),
 * a normal state for an athlete lifting without a program, and the page renders
 * its NEXT UP panel empty. `/api/muscle-recovery` feeds only the muscle sheet's
 * "Last trained" line, so any failure there resolves to `null` and the sheet
 * omits that line rather than the page blanking.
 *
 * The four routes are independent read models over the same store, so they are
 * fetched in parallel; a failure in week or strength still throws, because a
 * figure with no volume data is a broken page rather than a quiet one.
 */
import type {
  MusclePlanView,
  MuscleRecoveryView,
  MuscleStrengthView,
  MuscleWeekView,
} from '../../read-models/index.js';

async function json<T>(input: string): Promise<T> {
  const res = await fetch(input, { cache: 'no-store' });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(detail?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchMuscleWeek(): Promise<MuscleWeekView> {
  return json('/api/muscle-week');
}

export function fetchMuscleStrength(): Promise<MuscleStrengthView> {
  return json('/api/muscle-strength');
}

/** `null` on any failure — see this module's header. */
export function fetchMuscleRecovery(): Promise<MuscleRecoveryView | null> {
  return json<MuscleRecoveryView>('/api/muscle-recovery').catch(() => null);
}

/** `null` when no training week is active — see this module's header. */
export function fetchMusclePlan(): Promise<MusclePlanView | null> {
  return json('/api/muscle-plan');
}
