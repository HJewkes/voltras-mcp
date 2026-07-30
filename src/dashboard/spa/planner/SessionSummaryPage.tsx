/**
 * Session-completion / progression screen (VW-120).
 *
 * One card per exercise the session TOUCHED — VW-114's `session.set_exercise`
 * means a session routinely spans several, so nothing here assumes one exercise
 * per session; the grouping is done server-side in `session-summary.ts` from each
 * set's own `exerciseId`.
 *
 * Loads once per session id (a finished session's numbers don't move), so this
 * page does not poll.
 *
 * ── Information architecture (prior art, not invented here) ────────────────
 * The order is the one both the mobile `WorkoutSummary` screen and the archived
 * `session-debrief` lab directions converged on:
 *
 *   verdict → evidence → aggregate → prescription → raw sets
 *
 * Concretely, per exercise: titan's `VerdictHero` + `FatigueLights` carry the
 * SAME fatigue language the live page already speaks (`TONE_COLOR` /
 * `STATE_LABEL` / the three VEL·ROM·TEMPO dots), so a completion screen reads as
 * the end of the live page rather than a different product. Then the real
 * evidence — a `StrengthTrendChart` of the exercise's within-session estimated
 * 1RM (see `e1rmSeries`) — then the aggregate tiles, then the progression
 * recommendation `plan.suggest_progression` would give, then the set table.
 *
 * `FatigueMeter` renders the exercise's worst within-set velocity loss against
 * the standard VL10/20/30 thresholds — the same gauge the mobile summary used
 * for "fatigue index", except reading a measured number instead of a label.
 *
 * ── Styling ────────────────────────────────────────────────────────────────
 * titan components throughout (the first cut was plain DOM + inline styles).
 * LAYOUT via `style`, never `className` — react-native-web silently drops
 * Tailwind layout utilities. Same rule the live page follows.
 */
import React, { useEffect } from 'react';
import { useStore } from 'zustand';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Caption,
  Divider,
  EmptyState,
  FatigueLights,
  FatigueMeter,
  MetricTiles,
  Overline,
  PrBadge,
  Spinner,
  StrengthTrendChart,
  Surface,
  Typography,
  VerdictHero,
  TONE_COLOR,
  type MetricTileData,
} from '@titan-design/react-ui';

import { dashboardStore } from '../store';
import { fetchSessionSummary } from './planner-client';
import {
  e1rmChangePct,
  e1rmSeries,
  formatNumber,
  nextTargetWeightLbs,
  progressionLabel,
  sessionRollup,
  setLine,
  setsAgainstPlan,
} from './planner-model';
import { ErrorNote, PAGE_PADDING } from './PlanBuilderPage';
import type { SessionSummaryExercise } from '../../read-models/session-summary-view';

/** Plot width for the per-exercise trend chart. `StrengthTrendChart` requires px. */
const CHART_WIDTH = 460;
const CHART_HEIGHT = 150;

export function SessionSummaryPage(props: { sessionId: string }): React.JSX.Element {
  const summary = useStore(dashboardStore, (s) => s.sessionSummary);
  const error = useStore(dashboardStore, (s) => s.plannerError);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await fetchSessionSummary(props.sessionId);
        if (!cancelled) {
          dashboardStore.getState().applyPlanner({ sessionSummary: loaded, plannerError: null });
        }
      } catch (err) {
        if (!cancelled) {
          dashboardStore
            .getState()
            .applyPlanner({ sessionSummary: null, plannerError: (err as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.sessionId]);

  if (error !== null) {
    return (
      <Surface level="background" style={{ minHeight: '100%', padding: PAGE_PADDING }}>
        <ErrorNote message={error} />
      </Surface>
    );
  }
  if (summary === null) {
    return (
      <Surface
        level="background"
        style={{ minHeight: '100%', padding: PAGE_PADDING, alignItems: 'center' }}
      >
        <Spinner />
        <Caption color="tertiary">Loading session summary…</Caption>
      </Surface>
    );
  }

  const rollup = sessionRollup(summary);
  const headline: MetricTileData[] = [
    { label: 'Exercises', value: `${rollup.exerciseCount}` },
    { label: 'Sets', value: `${rollup.setCount}` },
    { label: 'Reps', value: `${rollup.totalReps}` },
    { label: 'Volume', value: formatNumber(rollup.volumeLbs, 'lb') },
    {
      label: 'Duration',
      value: rollup.durationMin === null ? 'in progress' : `${rollup.durationMin} min`,
    },
  ];

  return (
    <Surface level="background" style={{ minHeight: '100%', padding: PAGE_PADDING, gap: 16 }}>
      <Card variant="elevated">
        <CardHeader>
          <CardTitle>
            {summary.session.endedAt === null ? 'Session in progress' : 'Session complete'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Caption color="tertiary">
            {new Date(summary.session.startedAt).toLocaleString()}
            {summary.session.endedAt !== null &&
              ` → ${new Date(summary.session.endedAt).toLocaleTimeString()}`}
          </Caption>
          <div style={{ marginTop: 10 }}>
            <MetricTiles metrics={headline} gap={2} />
          </div>
        </CardContent>
      </Card>
      {summary.exercises.length === 0 ? (
        <EmptyState
          title="No sets recorded"
          description="This session ended without a completed set."
        />
      ) : (
        summary.exercises.map((exercise) => (
          <ExerciseCard key={exercise.exerciseId ?? 'unattributed'} exercise={exercise} />
        ))
      )}
    </Surface>
  );
}

function ExerciseCard(props: { exercise: SessionSummaryExercise }): React.JSX.Element {
  const { exercise } = props;
  const series = e1rmSeries(exercise);
  const changePct = e1rmChangePct(series);
  const tiles: MetricTileData[] = [
    { label: 'Sets', value: setsAgainstPlan(exercise) },
    { label: 'Reps', value: `${exercise.totalReps}` },
    { label: 'Top load', value: formatNumber(exercise.topWeightLbs, 'lb') },
    { label: 'Volume', value: formatNumber(exercise.volumeLbs, 'lb') },
    { label: 'Best velocity', value: formatNumber(exercise.bestRepVelocity) },
  ];

  return (
    <Card variant="elevated">
      <CardHeader>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ flex: '1 1 0', minWidth: 0 }}>
            <CardTitle>{exercise.name}</CardTitle>
          </div>
          {/* PR here means best OF THIS SESSION — the page only ever receives one
              session, so it cannot honestly claim an all-time PR (gap note). */}
          {series.some((p) => p.isPR === true) && <PrBadge type="e1rm" compact />}
        </div>
      </CardHeader>
      <CardContent>
        {/* Verdict first — the same hero word + three dimension lights the live
            page shows mid-set, so the completion screen closes that loop. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          <VerdictHero rpe={exercise.fatigue?.rpe ?? null} verdict={exercise.verdict} />
          <FatigueLights dimensions={exercise.verdict?.dimensions ?? null} />
          {exercise.fatigue !== null && (
            <Caption color="tertiary">RIR {formatNumber(exercise.fatigue.rir)}</Caption>
          )}
        </div>
        {/* Say WHICH set the headline read. The verdict and the gauge below now
            share one basis (VW-121 / F4) — naming it is what lets a reader check
            that, instead of taking two numbers on faith. */}
        {exercise.verdictSetIndex !== null && (
          <Caption color="tertiary">Verdict reads set #{exercise.verdictSetIndex}</Caption>
        )}
        <div style={{ marginTop: 16 }}>
          <MetricTiles metrics={tiles} gap={2} />
        </div>
        <div style={{ marginTop: 16 }}>
          <E1RMTrend series={series} changePct={changePct} />
        </div>
        <div style={{ marginTop: 16 }}>
          <Overline color="tertiary">Worst within-set velocity loss</Overline>
          <FatigueMeter value={exercise.maxVelocityLossPct ?? 0} />
          <Caption color="tertiary">
            {exercise.maxVelocityLossPct === null
              ? 'No velocity telemetry for this exercise.'
              : `${formatNumber(exercise.maxVelocityLossPct)}% peak-to-last within a set` +
                (exercise.verdictSetIndex === null
                  ? '.'
                  : ` — set #${exercise.verdictSetIndex}, the set the verdict above reads.`)}
          </Caption>
        </div>
        <Divider />
        <ProgressionBlock exercise={exercise} />
        <Divider />
        <SetTable exercise={exercise} />
      </CardContent>
    </Card>
  );
}

/**
 * The exercise's within-session estimated-1RM curve.
 *
 * Fewer than two points is NOT a chart — one working set has no trend, and
 * `StrengthTrendChart` would draw a lone dot that reads like a flat line. Say so
 * instead.
 */
function E1RMTrend(props: {
  series: ReturnType<typeof e1rmSeries>;
  changePct: number | null;
}): React.JSX.Element {
  if (props.series.length < 2) {
    return (
      <Caption color="tertiary">
        Not enough working sets with a recorded load to plot an e1RM trend.
      </Caption>
    );
  }
  const { changePct } = props;
  return (
    <div>
      <Overline color="tertiary">Estimated 1RM across this session</Overline>
      <StrengthTrendChart
        data={props.series}
        width={CHART_WIDTH}
        height={CHART_HEIGHT}
        unit="lbs"
        animateOnMount={false}
      />
      {changePct !== null && (
        <Typography
          variant="body2"
          style={{
            color:
              changePct <= -5 ? TONE_COLOR.alarm : changePct < -1 ? TONE_COLOR.warn : TONE_COLOR.ok,
          }}
        >
          {`${changePct >= 0 ? '+' : ''}${formatNumber(changePct)}% e1RM from first working set to last`}
        </Typography>
      )}
    </div>
  );
}

function ProgressionBlock(props: { exercise: SessionSummaryExercise }): React.JSX.Element {
  const { progression, progressionNote } = props.exercise;
  if (progression === null) {
    return (
      <div style={{ marginTop: 12 }}>
        <Overline color="tertiary">Next session</Overline>
        <Caption color="tertiary">{progressionNote ?? 'No progression recommendation.'}</Caption>
      </div>
    );
  }
  const tone =
    progression.delta > 0
      ? TONE_COLOR.ok
      : progression.delta < 0
        ? TONE_COLOR.alarm
        : TONE_COLOR.warn;
  return (
    <div style={{ marginTop: 12 }}>
      <Overline color="tertiary">Next session</Overline>
      <MetricTiles
        gap={2}
        metrics={[
          { label: 'Recommendation', value: progressionLabel(progression), valueColor: tone },
          { label: 'Target load', value: formatNumber(nextTargetWeightLbs(props.exercise), 'lb') },
        ]}
      />
      <Caption color="tertiary">{progression.reasoning}</Caption>
    </div>
  );
}

function SetTable(props: { exercise: SessionSummaryExercise }): React.JSX.Element {
  return (
    <div style={{ marginTop: 12 }}>
      <Overline color="tertiary">Sets</Overline>
      {props.exercise.sets.map((set) => (
        <div
          key={set.id}
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            paddingTop: 6,
            paddingBottom: 6,
          }}
        >
          <div style={{ width: 36 }}>
            <Caption color="tertiary">#{set.index}</Caption>
          </div>
          <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <Typography variant="body2">{setLine(set)}</Typography>
          </div>
          {set.isWarmup && <Caption color="tertiary">warm-up</Caption>}
          <div style={{ width: 110 }}>
            <Caption color="tertiary">
              loss {set.velocityLossPct === null ? '—' : `${formatNumber(set.velocityLossPct)}%`}
            </Caption>
          </div>
          <div style={{ width: 110 }}>
            <Caption color="tertiary">best {formatNumber(set.bestRepVelocity)}</Caption>
          </div>
        </div>
      ))}
    </div>
  );
}
