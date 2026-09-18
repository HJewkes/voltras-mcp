/**
 * Store → pinned live strip adapter (VW-429).
 *
 * The one-row strip every NON-live route pins above its content while a set runs or a
 * rest counts down, so the athlete's set is never off-view. Pure projection over the same
 * store slices the live page reads — it goes through {@link mapStoreToDashboardModel} and
 * {@link buildCurrentSet} rather than re-reading the snapshot, so the strip and the live
 * page cannot disagree about the same set. No new server state: every field here is
 * already on the snapshot, the prescription, or the client rest clock.
 *
 * Each provisional rule (zone source, fatigue cut, rest without a target, no plan) lives
 * in its own small function so a ruling on it is a one-function change.
 */
import { categorizeVelocity, type VelocityZoneId } from '@voltras/workout-analytics';

import { buildCurrentSet } from '../adapter';
import { type Route } from '../routing';
import {
  activeCompletedSets,
  plannedRepCount,
  velocityLossPct,
  verdictFromLoss,
  type DashboardModel,
  type SessionModel,
} from '../live-page/model';
import { formatMass, type MassUnit } from '../live-page/mass';
import { mapStoreToDashboardModel, type LiveViewSources } from './live-view';

/** One performed rep on the strip: mean concentric velocity (m/s) and its analytics zone. */
export interface LiveStripRepModel {
  velocity: number;
  zone: VelocityZoneId;
}

/** The strip's data props; `onPress` and layout are the component's concern. */
export interface LiveStripModel {
  state: 'set' | 'rest';
  exerciseName: string;
  /** In `set`, the set being lifted. In `rest`, the set that comes next. */
  setNumber: number;
  setCount: number;
  loadLabel?: string;
  reps: LiveStripRepModel[];
  targetReps: number;
  isFatigued: boolean;
  restRemainingMs?: number;
  restDurationMs?: number;
}

/** A rep's zone: WA's classifier on its global-default bands. */
export function repZone(meanVelocityMps: number): VelocityZoneId {
  return categorizeVelocity(meanVelocityMps);
}

/** Red on the strip exactly when the live aura is red: the same call on the same loss. */
export function isFatiguedFromLoss(lossPct: number | null): boolean {
  return verdictFromLoss(lossPct) === 'stop';
}

/** No plan means no honest "set n of m", so the strip hides rather than inventing a count. */
function plannedSetCount(session: SessionModel): number | null {
  return session.plannedSets;
}

/** Rest with no prescribed length has no countdown to show, so the strip hides. */
function restDurationMs(session: SessionModel): number | null {
  return session.restSec === null ? null : session.restSec * 1000;
}

function stripReps(velocities: readonly number[]): LiveStripRepModel[] {
  return velocities.map((velocity) => ({ velocity, zone: repZone(velocity) }));
}

function loadLabel(weightLbs: number | null, unit: MassUnit): string | undefined {
  if (weightLbs === null) return undefined;
  const mass = formatMass(weightLbs, unit);
  return `${mass.value} ${mass.unit === 'lbs' ? 'lb' : 'kg'}`;
}

/** The set being lifted, or null when the plan cannot state a set count. */
function setStrip(
  model: DashboardModel,
  sources: LiveViewSources,
  unit: MassUnit,
): LiveStripModel | null {
  const { session } = model;
  const setCount = plannedSetCount(session);
  if (setCount === null || sources.snapshot === null) return null;
  const current = buildCurrentSet(sources.snapshot, unit);
  const setNumber = activeCompletedSets(session).length + 1;
  return {
    state: 'set',
    exerciseName: session.exerciseName,
    setNumber,
    setCount: Math.max(setCount, setNumber),
    loadLabel: loadLabel(session.weightLbs, unit),
    reps: stripReps(current.velocitiesMps),
    targetReps: plannedRepCount(session) ?? Math.max(current.reps, 1),
    isFatigued: isFatiguedFromLoss(current.velocityLossPct),
  };
}

/** The rest countdown, showing the set just finished; null once the rest has run out. */
function restStrip(model: DashboardModel, unit: MassUnit): LiveStripModel | null {
  const { session, restElapsedMs } = model;
  const setCount = plannedSetCount(session);
  const durationMs = restDurationMs(session);
  if (setCount === null || durationMs === null || restElapsedMs === null) return null;
  const remainingMs = durationMs - restElapsedMs;
  if (remainingMs <= 0) return null;
  const done = activeCompletedSets(session);
  const last = done[done.length - 1];
  const setNumber = done.length + 1;
  return {
    state: 'rest',
    exerciseName: session.exerciseName,
    setNumber,
    setCount: Math.max(setCount, setNumber),
    loadLabel: loadLabel(last?.weightLbs ?? session.weightLbs, unit),
    reps: stripReps(last?.reps ?? []),
    targetReps: plannedRepCount(session) ?? Math.max(last?.repCount ?? 0, 1),
    isFatigued: isFatiguedFromLoss(velocityLossPct(last?.reps ?? [])),
    restRemainingMs: remainingMs,
    restDurationMs: durationMs,
  };
}

/**
 * The strip for `route`, or null when it renders nothing: on the live page itself, before
 * the first snapshot, with no open session, and whenever neither a set nor a rest runs.
 */
export function mapStoreToLiveStrip(sources: LiveViewSources, route: Route): LiveStripModel | null {
  if (route.name === 'live') return null;
  const model = mapStoreToDashboardModel(sources);
  if (model === null || !model.session.hasSession) return null;
  const unit = sources.displayUnit ?? 'lbs';
  return sources.snapshot?.sets.active ? setStrip(model, sources, unit) : restStrip(model, unit);
}
