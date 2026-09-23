// Everything the report computes, as one JSON document for the visual walkthrough. Unrounded, ISO dates, lb.

import { trainingGaps } from '../../../src/analytics/training-days.js';
import { POPULATION_VOLUME_LANDMARKS } from '../../../src/dashboard/read-models/muscle-week.js';
import type { TitanMuscleGroup } from '../../../src/exercises/muscle-map.js';

import { bodyweightPhases, readingsOf, type BodyweightPhase } from './bodyweight.js';
import { boundariesOf } from './checks/deload.js';
import { muscleVerdicts } from './checks/missed.js';
import { e1rmTrend, topLoadTrend } from './checks/progression.js';
import { systemicWeeks } from './checks/volume.js';
import type { Context, JudgedBlock, MainLift } from './context.js';
import { addDays } from './dates.js';
import { isWorkRow, LOW_CONFIDENCE } from './log-rules.js';
import { classifyMesoLength, MESO_RULE, mesosBetween } from './meso.js';
import { inPeriod, type Period } from './periods.js';
import { plateauWindows, type TrendRead } from './plateaus.js';
import { underperformanceRuns } from './underperformance.js';
import {
  modalWeeklyCount,
  sessionsPerWeek,
  volumeStatus,
  weeklyFrequencyByMuscle,
  weeklySetsByMuscle,
} from './weekly.js';

/** The top-level keys, in order; the test and the schema note both read this list. */
export const RETRO_DATA_KEYS = [
  'meta',
  'lifts',
  'misses',
  'volume',
  'boundaries',
  'mesos',
  'adherence',
  'bodyweight',
] as const;

type RetroData = Record<(typeof RETRO_DATA_KEYS)[number], unknown>;

/** A period's first and last training day, in place of the open-ended bounds the checks use. */
function periodRange(ctx: Context, period: Period) {
  const days = ctx.days.filter((day) => inPeriod(day, period));
  return {
    name: period.name,
    first: days[0] ?? null,
    last: days.at(-1) ?? null,
    trainingDays: days.length,
  };
}

function meta(ctx: Context, generatedOn: string) {
  const work = ctx.rows.filter(isWorkRow);
  return {
    generated: generatedOn,
    unit: 'lb',
    dateRange: { first: ctx.days[0] ?? null, last: ctx.days.at(-1) ?? null },
    programmeSplit: ctx.programmeSplit,
    sameCoachAcrossSplit: true,
    periods: ctx.periods.map((period) => periodRange(ctx, period)),
    counts: {
      setRows: ctx.rows.length,
      workRows: work.length,
      workRowsWithoutDivider: work.filter((r) => r.is_warmup === null).length,
      lowConfidenceRows: ctx.rows.filter((r) => r.confidence < LOW_CONFIDENCE).length,
      workSets: work.reduce((sum, r) => sum + r.sets, 0),
      trainingDays: ctx.days.length,
      unmappedWorkRows: work.filter((r) => !ctx.lookup.isMapped(r.exercise_name)).length,
    },
  };
}

function trendJson(trend: TrendRead | null) {
  return trend === null
    ? null
    : {
        slopePerWeek: trend.slopePerWeek,
        ci95PerWeek: trend.ci95PerWeek,
        rSquared: trend.rSquared,
        n: trend.points,
      };
}

function liftJson(ctx: Context, lift: MainLift) {
  const { points, modalReps, label } = lift.series;
  return {
    lift: label,
    family: lift.family,
    modalReps,
    sessions: points.map((p) => ({
      date: p.date,
      topLoad: p.topLoad,
      topLoadAtModalReps: p.topLoadAtModal,
      e1rm: p.bestE1RM,
      sets: p.sets,
      totalReps: p.totalReps,
    })),
    slopes: ctx.periods.map((period) => ({
      period: period.name,
      e1rm: trendJson(e1rmTrend(points, period)),
      topLoadAtModalReps: trendJson(topLoadTrend(points, period)),
    })),
    plateaus: plateauWindows(points, lift.familyDates).map((w) => ({
      start: w.startDate,
      end: w.endDate,
      sessions: w.sessions,
      rule: w.flatline ? 'flatline' : 'wa_window',
      outcome: w.followUp,
    })),
  };
}

function monthly(judged: readonly JudgedBlock[], keyOf: (e: JudgedBlock) => string) {
  const tallies = new Map<
    string,
    { judged: number; missed: number; underPrescribedLoad: number }
  >();
  for (const entry of judged) {
    if (entry.verdict.verdict === 'no-target') continue;
    const t = tallies.get(keyOf(entry)) ?? { judged: 0, missed: 0, underPrescribedLoad: 0 };
    t.judged += 1;
    t.missed += entry.verdict.verdict === 'miss' ? 1 : 0;
    t.underPrescribedLoad += entry.verdict.loadShort ? 1 : 0;
    tallies.set(keyOf(entry), t);
  }
  return [...tallies]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, t]) => ({ key, ...t, rate: t.missed / t.judged }));
}

function blockJson({ block, verdict }: JudgedBlock) {
  return {
    date: block.date,
    lift: block.exercise,
    prescribedSets: verdict.target?.sets ?? null,
    prescribedReps: verdict.target?.repsLow ?? null,
    prescribedLoad: verdict.target?.loadLbs ?? null,
    doneSets: verdict.reportedSets,
    minReps: verdict.minReps,
    verdict: verdict.verdict,
    missed: verdict.verdict === 'miss',
    setsShort: verdict.setsShort,
    underPrescribedLoad: verdict.loadShort,
    repsFromPrescription: verdict.repsFromPrescription,
    lowConfidence: block.rows.some((r) => r.confidence < LOW_CONFIDENCE),
  };
}

function misses(ctx: Context) {
  return {
    monthly: monthly(ctx.judged, (e) => e.block.date.slice(0, 7)).map(({ key, ...rest }) => ({
      month: key,
      ...rest,
    })),
    perLift: monthly(ctx.judged, (e) => e.block.exercise ?? '(no name)').map(
      ({ key, ...rest }) => ({ lift: key, ...rest }),
    ),
    runs: underperformanceRuns(muscleVerdicts(ctx)).map((r) => ({
      muscle: r.muscle,
      start: r.startDate,
      end: r.endDate,
      sessions: r.sessions,
      dates: r.dates,
    })),
    blocks: ctx.judged.map(blockJson),
  };
}

function volume(ctx: Context) {
  const weeks = weeklySetsByMuscle(ctx.rows, ctx.lookup);
  return {
    landmarks: POPULATION_VOLUME_LANDMARKS,
    landmarkBasis: 'population-default',
    weeks: [...weeks]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, muscles]) => ({
        week,
        muscles: [...muscles].map(([muscle, sets]) => ({
          muscle,
          sets,
          band: volumeStatus(muscle, sets),
        })),
      })),
    systemicWeeks: [...systemicWeeks(ctx)].map(([week, muscles]) => ({ week, muscles })),
  };
}

function boundaries(ctx: Context) {
  return boundariesOf(ctx).map((b) => ({
    week: b.week,
    triggers: b.triggers,
    kinds: [...(b.gapDays === null ? [] : ['gap']), ...(b.drops.length === 0 ? [] : ['load_drop'])],
    gapDays: b.gapDays,
    dropLifts: b.drops,
  }));
}

function mesos(ctx: Context) {
  return mesosBetween(ctx.days, boundariesOf(ctx)).map((m) => ({
    start: m.startWeek,
    nextStart: m.endWeek,
    calendarWeeks: m.weeks,
    trainedWeeks: m.trainedWeeks,
    verdict: classifyMesoLength(m.trainedWeeks),
  }));
}

function adherence(ctx: Context) {
  const perWeek = sessionsPerWeek(ctx.days);
  const frequency = weeklyFrequencyByMuscle(ctx.rows, ctx.lookup);
  const muscleDays = (week: string) =>
    Object.fromEntries(frequency.get(week) ?? new Map<TitanMuscleGroup, number>());
  return {
    trainingDays: ctx.days,
    modalSessionsPerWeek: modalWeeklyCount(perWeek.values()),
    weeks: [...perWeek].map(([week, sessions]) => ({
      week,
      sessions,
      muscleSessions: muscleDays(week),
    })),
    gaps: trainingGaps(ctx.days)
      .filter((g) => g.days > MESO_RULE.gapDays)
      .map((g) => ({ start: addDays(g.endsOn, -g.days), end: g.endsOn, days: g.days })),
  };
}

function phaseJson(ctx: Context, phase: BodyweightPhase) {
  const period = { name: '', from: phase.startDate, to: addDays(phase.endDate, 1) };
  return {
    start: phase.startDate,
    end: phase.endDate,
    kind: phase.label,
    readings: phase.readings.length,
    slopeLbsPerWeek: phase.slopeLbsPerWeek,
    pctPerWeek: phase.pctPerWeek,
    totalPct: phase.cumulativePct,
    dietFatigueBand: phase.dietFatigueBand,
    liftSlopes: ctx.mainLifts.map((lift) => ({
      lift: lift.series.label,
      e1rm: trendJson(e1rmTrend(lift.series.points, period)),
    })),
  };
}

function bodyweight(ctx: Context) {
  const weight = readingsOf(ctx.checkins, 'Weight');
  const waist = readingsOf(ctx.checkins, 'Waist');
  return {
    weight: weight.readings,
    waist: waist.readings,
    dropped: [
      ...weight.dropped.map((r) => ({ ...r, field: 'Weight' })),
      ...waist.dropped.map((r) => ({ ...r, field: 'Waist' })),
    ],
    phases: bodyweightPhases(weight.readings).map((phase) => phaseJson(ctx, phase)),
  };
}

export function buildRetroData(ctx: Context, generatedOn: string): RetroData {
  return {
    meta: meta(ctx, generatedOn),
    lifts: ctx.mainLifts.map((lift) => liftJson(ctx, lift)),
    misses: misses(ctx),
    volume: volume(ctx),
    boundaries: boundaries(ctx),
    mesos: mesos(ctx),
    adherence: adherence(ctx),
    bodyweight: bodyweight(ctx),
  };
}
