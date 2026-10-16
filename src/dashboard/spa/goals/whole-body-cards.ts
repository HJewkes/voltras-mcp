/**
 * Pure projections from the goals payload onto titan's whole-body cards and the
 * priority index (VW-455, shape B). No I/O, no clock: the read model already
 * carries the direction, the diet phase now, the rate and the session window
 * (VW-459), so nothing here re-derives a number.
 */
import type {
  GoalPriorityIndexEntry,
  WholeBodyRate,
  WholeBodySessionsRow,
  WholeBodyWeightRow,
} from '@titan-design/react-ui';

import {
  GOAL_PROGRESS_CONSTANTS,
  type GoalBodyweightRateView,
  type GoalProgressView,
} from '../../read-models/goal-progress.js';
import { convertMass, type MassUnit } from '../live-page/mass.js';
import { bodyweightTarget, sessionsTarget, type GoalsPageData } from './goals-model.js';

/** The two cards the whole-body section draws; at least one is present. */
export interface WholeBodyCards {
  bodyweight: WholeBodyWeightRow | null;
  sessions: WholeBodySessionsRow | null;
}

/** `null` with no whole-body goal: the section is dropped (owner, "If no Whole Body goals drop the section"). */
export function wholeBodyCards(data: GoalsPageData, unit: MassUnit = 'lbs'): WholeBodyCards | null {
  const bodyweight = bodyweightTarget(data);
  const sessions = sessionsTarget(data);
  if (bodyweight === null && sessions === null) return null;
  return {
    bodyweight: bodyweight === null ? null : weightRow(bodyweight.view, unit),
    sessions: sessions === null ? null : sessionsRow(sessions.view),
  };
}

/**
 * In kg the weigh-in and band convert unrounded: the card prints bodyweight to one decimal
 * in whichever unit it is told, which keeps the precision a kg check-in entry carries.
 */
export function weightRow(view: GoalProgressView, unit: MassUnit = 'lbs'): WholeBodyWeightRow {
  const latest = view.actuals[view.actuals.length - 1];
  const diet = view.bodyweight?.dietPhase;
  const inKg = unit === 'kg' && view.nextMilestone.unit === 'lb';
  const shown = (value: number): number => (inKg ? convertMass(value, 'kg') : value);
  return {
    status: view.status,
    basis: view.statusBasis,
    unit: inKg ? 'kg' : view.nextMilestone.unit,
    direction: view.direction,
    phase: {
      name: diet?.phase ?? 'unknown',
      ...(diet?.recompMode === 'slow-loss' ? { slowLoss: true } : {}),
    },
    latest: latest === undefined ? null : { value: shown(latest.value), ts: latest.ts },
    week: currentWeek(view, shown),
    rate: rateOf(view.bodyweight?.rate ?? null),
  };
}

/** This week of the block and its band row; week 1 when the view has no week to sit in. */
function currentWeek(
  view: GoalProgressView,
  shown: (value: number) => number,
): WholeBodyWeightRow['week'] {
  const n = view.mesoWeek?.n ?? 1;
  const row = view.expected.find((point) => point.weekIndex === n) ?? view.expected[0];
  return {
    index: n,
    of: view.mesoWeek?.of ?? view.expected.length,
    low: shown(row?.low ?? view.committed),
    high: shown(row?.high ?? view.stretch),
  };
}

function rateOf(rate: GoalBodyweightRateView | null): WholeBodyRate | null {
  if (rate === null) return null;
  return {
    observedPctPerWeek: rate.observedPctPerWeek,
    bandLowPctPerWeek: rate.bandLowPctPerWeek,
    bandHighPctPerWeek: rate.bandHighPctPerWeek,
    vetoed: rate.vetoed,
  };
}

export function sessionsRow(view: GoalProgressView): WholeBodySessionsRow {
  return {
    status: view.status,
    basis: view.statusBasis,
    counted: view.actuals[view.actuals.length - 1]?.value ?? 0,
    committed: view.committed,
    // The read model pro-rates only the first window; once it is full the whole commitment is due.
    dueByNow: view.sessions?.dueByNow ?? view.committed,
    windowDays: GOAL_PROGRESS_CONSTANTS.sessionWindowDays,
    agingOutNext7d: view.sessions?.agingOutNext7d ?? null,
  };
}

/** Every declared priority, in declaration order; one with no accepted target says so. */
export function priorityIndexEntries(data: GoalsPageData): GoalPriorityIndexEntry[] {
  return data.priorities.map((row) => ({
    name: sentenceCase(row.priority.ref),
    level: row.priority.level,
    hasTarget: row.targets.length > 0,
  }));
}

function sentenceCase(slug: string): string {
  const words = slug.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
