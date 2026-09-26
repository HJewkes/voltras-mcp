// Everything the report computes, as one JSON document for the visual walkthrough. Unrounded, ISO dates, lb.

import { trainingGaps } from '../../../src/analytics/training-days.js';
import { POPULATION_VOLUME_LANDMARKS } from '../../../src/dashboard/read-models/muscle-week.js';
import type { TitanMuscleGroup } from '../../../src/exercises/muscle-map.js';

import { bodyweightPhases, readingsOf, type BodyweightPhase } from './bodyweight.js';
import { adherenceFigures } from './checks/adherence.js';
import { boundariesOf, choiceOf, confirmedBoundaries, decisionsFinding } from './checks/deload.js';
import { liftCarries, liftRestarts, ramps } from './checks/meso-reviews.js';
import { missedFigures, muscleVerdicts } from './checks/missed.js';
import { e1rmTrend, progressionFigures, topLoadTrend } from './checks/progression.js';
import { labelCounts, mesoLabels, segmentContext, type Segmented } from './checks/segments.js';
import { systemicWeeks, volumeFigures } from './checks/volume.js';
import type { Context, JudgedBlock, MainLift } from './context.js';
import { addDays, isoWeekStart } from './dates.js';
import { isWorkRow, LOW_CONFIDENCE } from './log-rules.js';
import type { Figure } from './markdown.js';
import { classifyMesoLength, MESO_RULE, mesosBetween } from './meso.js';
import { inPeriod, type Period } from './periods.js';
import { plateauWindows, type TrendRead } from './plateaus.js';
import { ruleText, SEGMENT_RULE } from './segmentation.js';
import { underperformanceRuns } from './underperformance.js';
import {
  modalWeeklyCount,
  sessionsPerWeek,
  volumeStatus,
  weeklyDoseByMuscle,
  weeklyDoseFrequencyByMuscle,
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
  'segments',
  'regularOnly',
  'mesoChecks',
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

/** One week's muscles in either read: landmark `sets` with its band (null for none or unverified), and the unbanded `dose`. */
function weekMuscles(
  sets: ReadonlyMap<TitanMuscleGroup, number>,
  dose: ReadonlyMap<TitanMuscleGroup, number>,
) {
  const muscles = [...new Set([...sets.keys(), ...dose.keys()])];
  return muscles.map((muscle) => {
    const landmarkSets = sets.get(muscle) ?? 0;
    return {
      muscle,
      sets: landmarkSets,
      band: landmarkSets > 0 ? volumeStatus(muscle, landmarkSets) : null,
      dose: dose.get(muscle) ?? 0,
    };
  });
}

function volume(ctx: Context) {
  const weeks = weeklySetsByMuscle(ctx.rows, ctx.lookup);
  const dose = weeklyDoseByMuscle(ctx.rows, ctx.lookup);
  return {
    landmarks: POPULATION_VOLUME_LANDMARKS,
    landmarkBasis: 'population-default',
    weeks: [...weeks]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, muscles]) => ({
        week,
        muscles: weekMuscles(muscles, dose.get(week) ?? new Map()),
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
    choice: choiceOf(ctx, b.week),
  }));
}

function mesos(ctx: Context) {
  return mesosBetween(ctx.days, confirmedBoundaries(ctx)).map((m) => ({
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
  const doseFrequency = weeklyDoseFrequencyByMuscle(ctx.rows, ctx.lookup);
  const muscleDays = (read: typeof frequency, week: string) =>
    Object.fromEntries(read.get(week) ?? new Map<TitanMuscleGroup, number>());
  return {
    trainingDays: ctx.days,
    modalSessionsPerWeek: modalWeeklyCount(perWeek.values()),
    weeks: [...perWeek].map(([week, sessions]) => ({
      week,
      sessions,
      muscleSessions: muscleDays(frequency, week),
      muscleDoseSessions: muscleDays(doseFrequency, week),
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

function comparison(figures: (ctx: Context) => Figure[], ctx: Context, regular: Context) {
  const regularByLabel = new Map(figures(regular));
  return figures(ctx).map(([figure, all]) => ({
    figure,
    all,
    regular: regularByLabel.get(figure) ?? 'n/a',
  }));
}

function decisionsJson(ctx: Context) {
  return {
    present: ctx.decisions !== null,
    marked: ctx.decisions?.filter((d) => d.choice !== null).length ?? 0,
    plannedDeloads: ctx.decisions?.filter((d) => d.choice === 'planned_deload').length ?? 0,
    finding: decisionsFinding(ctx, boundariesOf(ctx)),
  };
}

function segments(ctx: Context, { segmentation, regular }: Segmented) {
  const labelOf = new Map(segmentation.weeks.map((w) => [w.week, w]));
  const trained = segmentation.weeks.filter((w) => w.label !== 'untrained');
  return {
    rule: SEGMENT_RULE,
    ruleText: ruleText(segmentation.modalSessionsPerWeek),
    decisions: decisionsJson(ctx),
    modalSessionsPerWeek: segmentation.modalSessionsPerWeek,
    weeks: segmentation.weeks,
    sessions: ctx.days.map((date) => {
      const week = labelOf.get(isoWeekStart(date))!;
      return { date, week: week.week, label: week.label, reasons: week.reasons };
    }),
    runs: segmentation.runs,
    gaps: segmentation.gaps,
    counts: { weeks: labelCounts(trained), sessions: labelCounts(trained, (w) => w.sessions) },
    mesos: mesoLabels(ctx, segmentation),
    comparisons: {
      progression: comparison(progressionFigures, ctx, regular),
      misses: comparison(missedFigures, ctx, regular),
      volume: comparison(volumeFigures, ctx, regular),
      adherence: comparison(adherenceFigures, ctx, regular),
    },
  };
}

/** Checks 1, 2, 3 and 5 over regular weeks only, in the same shapes; adherence lists trained weeks only. */
function regularOnly(regular: Context) {
  const regularAdherence = adherence(regular);
  return {
    lifts: regular.mainLifts.map((lift) => liftJson(regular, lift)),
    misses: misses(regular),
    volume: volume(regular),
    adherence: {
      ...regularAdherence,
      weeks: regularAdherence.weeks.filter((w) => w.sessions > 0),
      gaps: [],
    },
  };
}

export function buildRetroData(ctx: Context, generatedOn: string): RetroData {
  const segmented = segmentContext(ctx);
  return {
    meta: meta(ctx, generatedOn),
    lifts: ctx.mainLifts.map((lift) => liftJson(ctx, lift)),
    misses: misses(ctx),
    volume: volume(ctx),
    boundaries: boundaries(ctx),
    mesos: mesos(ctx),
    adherence: adherence(ctx),
    bodyweight: bodyweight(ctx),
    segments: segments(ctx, segmented),
    regularOnly: regularOnly(segmented.regular),
    mesoChecks: { restarts: liftRestarts(ctx), ramps: ramps(ctx), carries: liftCarries(ctx) },
  };
}
