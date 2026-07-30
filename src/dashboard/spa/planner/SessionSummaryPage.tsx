/**
 * Session-completion / progression screen (VW-120).
 *
 * One card per exercise the session TOUCHED — VW-114's `session.set_exercise`
 * means a session routinely spans several, so nothing here assumes one exercise
 * per session; the grouping is done server-side in `session-summary.ts` from each
 * set's own `exerciseId`.
 *
 * Each card carries the exercise's VBT rollup (working sets, top load, best rep
 * velocity, worst within-set velocity loss, fatigue verdict) and the load
 * recommendation `plan.suggest_progression` would give — computed by the SAME
 * `computeProgressionDelta` heuristic, not a second copy of it.
 *
 * Loads once per session id (a finished session's numbers don't move), so this
 * page does not poll.
 */
import React, { useEffect } from 'react';
import { useStore } from 'zustand';

import { dashboardStore } from '../store';
import { fetchSessionSummary } from './planner-client';
import {
  formatNumber,
  nextTargetWeightLbs,
  progressionLabel,
  setsAgainstPlan,
} from './planner-model';
import { styles, toneColor } from './planner-styles';
import type { SessionSummaryExercise } from '../../read-models/session-summary-view';

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

  if (error !== null) return <p style={styles.error}>{error}</p>;
  if (summary === null) return <p style={styles.subtle}>Loading session summary…</p>;

  return (
    <div>
      <div style={styles.card}>
        <h2 style={styles.heading}>Session complete</h2>
        <p style={styles.subtle}>
          {new Date(summary.session.startedAt).toLocaleString()}
          {summary.session.endedAt === null
            ? ' · still in progress'
            : ` → ${new Date(summary.session.endedAt).toLocaleTimeString()}`}
          {' · '}
          {summary.exercises.length} exercise{summary.exercises.length === 1 ? '' : 's'}
        </p>
      </div>
      {summary.exercises.length === 0 && (
        <p style={styles.subtle}>This session recorded no sets.</p>
      )}
      {summary.exercises.map((exercise) => (
        <ExerciseCard key={exercise.exerciseId ?? 'unattributed'} exercise={exercise} />
      ))}
    </div>
  );
}

function Metric(props: { label: string; value: string; tint?: string }): React.JSX.Element {
  return (
    <div>
      <div style={styles.subtle}>{props.label}</div>
      <div
        style={{
          ...styles.metricValue,
          ...(props.tint === undefined ? {} : { color: props.tint }),
        }}
      >
        {props.value}
      </div>
    </div>
  );
}

function ExerciseCard(props: { exercise: SessionSummaryExercise }): React.JSX.Element {
  const { exercise } = props;
  const nextTarget = nextTargetWeightLbs(exercise);
  return (
    <div style={styles.card}>
      <h3 style={styles.heading}>{exercise.name}</h3>
      <div style={styles.metric}>
        <Metric label="Sets" value={setsAgainstPlan(exercise)} />
        <Metric label="Total reps" value={`${exercise.totalReps}`} />
        <Metric label="Top load" value={formatNumber(exercise.topWeightLbs, 'lb')} />
        <Metric label="Volume" value={formatNumber(exercise.volumeLbs, 'lb')} />
        <Metric label="Best rep velocity" value={formatNumber(exercise.bestRepVelocity)} />
        <Metric
          label="Worst velocity loss"
          value={
            exercise.maxVelocityLossPct === null
              ? '—'
              : `${formatNumber(exercise.maxVelocityLossPct)}%`
          }
          tint={toneColor(exercise.verdict?.dimensions.velocityLoss ?? null)}
        />
        <Metric
          label="Verdict"
          value={exercise.verdict?.state ?? '—'}
          tint={toneColor(exercise.verdict?.tone ?? null)}
        />
        <Metric
          label="RIR / RPE"
          value={
            exercise.fatigue === null
              ? '—'
              : `${formatNumber(exercise.fatigue.rir)} / ${formatNumber(exercise.fatigue.rpe)}`
          }
        />
      </div>
      <ProgressionBlock exercise={exercise} nextTarget={nextTarget} />
      <SetTable exercise={exercise} />
    </div>
  );
}

function ProgressionBlock(props: {
  exercise: SessionSummaryExercise;
  nextTarget: number | null;
}): React.JSX.Element {
  const { progression, progressionNote } = props.exercise;
  if (progression === null) {
    return <p style={styles.subtle}>{progressionNote ?? 'No progression recommendation.'}</p>;
  }
  return (
    <div style={{ ...styles.card, marginBottom: 0, background: '#1f2937' }}>
      <div style={styles.metric}>
        <Metric
          label="Next session"
          value={progressionLabel(progression)}
          tint={toneColor(progression.delta > 0 ? 'ok' : progression.delta < 0 ? 'alarm' : 'warn')}
        />
        <Metric label="Target load" value={formatNumber(props.nextTarget, 'lb')} />
      </div>
      <p style={styles.subtle}>{progression.reasoning}</p>
    </div>
  );
}

function SetTable(props: { exercise: SessionSummaryExercise }): React.JSX.Element {
  return (
    <div style={{ marginTop: 12 }}>
      {props.exercise.sets.map((set) => (
        <div key={set.id} style={styles.row}>
          <span style={{ width: 32 }}>#{set.index}</span>
          <span style={{ flex: 1 }}>
            {set.repCount} reps
            {set.weightLbs === null ? '' : ` @ ${set.weightLbs} lb`}
            {set.isWarmup ? ' · warm-up' : ''}
          </span>
          <span style={styles.subtle}>
            loss {set.velocityLossPct === null ? '—' : `${formatNumber(set.velocityLossPct)}%`} ·
            best {formatNumber(set.bestRepVelocity)}
          </span>
        </div>
      ))}
    </div>
  );
}
