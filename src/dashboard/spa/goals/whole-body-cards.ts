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
import { bodyweightTarget, sessionsTarget, type GoalsPageData } from './goals-model.js';

/** The two cards the whole-body section draws; at least one is present. */
export interface WholeBodyCards {
  bodyweight: WholeBodyWeightRow | null;
  sessions: WholeBodySessionsRow | null;
}

/** `null` with no whole-body goal: the section is dropped (owner, "If no Whole Body goals drop the section"). */
export function wholeBodyCards(data: GoalsPageData): WholeBodyCards | null {
  const bodyweight = bodyweightTarget(data);
  const sessions = sessionsTarget(data);
  if (bodyweight === null && sessions === null) return null;
  return {
    bodyweight: bodyweight === null ? null : weightRow(bodyweight.view),
    sessions: sessions === null ? null : sessionsRow(sessions.view),
  };
}

export function weightRow(view: GoalProgressView): WholeBodyWeightRow {
  const latest = view.actuals[view.actuals.length - 1];
  const diet = view.bodyweight?.dietPhase;
  return {
    status: view.status,
    basis: view.statusBasis,
    unit: view.nextMilestone.unit,
    direction: view.direction,
    phase: {
      name: diet?.phase ?? 'unknown',
      ...(diet?.recompMode === 'slow-loss' ? { slowLoss: true } : {}),
    },
    latest: latest === undefined ? null : { value: latest.value, ts: latest.ts },
    week: currentWeek(view),
    rate: rateOf(view.bodyweight?.rate ?? null),
  };
}

/** This week of the block and its band row; week 1 when the view has no week to sit in. */
function currentWeek(view: GoalProgressView): WholeBodyWeightRow['week'] {
  const n = view.mesoWeek?.n ?? 1;
  const row = view.expected.find((point) => point.weekIndex === n) ?? view.expected[0];
  return {
    index: n,
    of: view.mesoWeek?.of ?? view.expected.length,
    low: row?.low ?? view.committed,
    high: row?.high ?? view.stretch,
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
