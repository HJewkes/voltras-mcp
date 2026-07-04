/**
 * Exercise hero panel (VMCP-01.50, Phase 6 — layout cohesion).
 *
 * The current exercise is the HERO, composed from titan-design's REAL Workout
 * organisms — `ExerciseCard` (expanded) with nested `SetRow`s — mirroring the
 * mobile app's ascending set-timeline (completed → active) instead of co-equal
 * Metric/Table tiles. This is the same design-system generation the mobile app
 * will consume once it bumps off @titan-design/react-ui@0.1.1 (VLT-09.33), so the
 * two surfaces converge on one component set.
 *
 * Data-shape gaps closed (rather than avoided): peak velocity rides SetRow's
 * built-in per-row VelocityStrip (`velocities`) instead of a bespoke column; the
 * prior set fills the PREV column; Mode is a per-exercise constant surfaced in
 * the live-status line, not per row; RPE is absent (never captured) and SetRow
 * renders it as an em-dash. A slim live-status strip carries the dashboard's
 * across-the-room glanceable signals (velocity-loss %, latest peak).
 *
 * a11y (preserves Phase 5): ARIA region named for the exercise; the set list is
 * aria-live="polite" so a completed set announces once (row count changes only on
 * set close — see reduceSnapshot). NDA: renders adapter view-models only.
 */
import { Card, CardContent, ExerciseCard, type ExerciseCardProps } from '@titan-design/react-ui';
import type { CurrentSetView, HeroSetRow } from '../adapter';

type SetRowProps = NonNullable<ExerciseCardProps['sets']>[number];

export interface ExerciseHeroProps {
  /** Active-session exercise name; `'—'` when idle. */
  exercise: string;
  hasSession: boolean;
  /** Per-exercise training mode (e.g. "weight Training"), for the status line. */
  mode: string;
  /** Live callout signals (velocity-loss %, latest peak) for the active set. */
  currentSet: CurrentSetView;
  /** Completed sets + the active set, ascending, in titan-SetRow shape. */
  heroSets: HeroSetRow[];
}

const rnd = (n: number | null): number | null => (n != null ? Math.round(n) : null);

function toSetRowProps(r: HeroSetRow): SetRowProps {
  return {
    mode: r.mode,
    setNumber: r.setNumber,
    reps: r.reps,
    weight: rnd(r.weightLbs),
    rpe: null,
    unit: 'lbs',
    velocities: r.velocitiesMps.length > 0 ? r.velocitiesMps : undefined,
    previous: r.previous
      ? { reps: r.previous.reps, weight: Math.round(r.previous.weightLbs) }
      : null,
    isNextSet: r.mode === 'active',
    targets:
      r.mode === 'active' && r.targetReps != null && r.targetWeightLbs != null
        ? { reps: r.targetReps, weight: Math.round(r.targetWeightLbs) }
        : undefined,
  };
}

export function ExerciseHeroPanel({
  exercise,
  hasSession,
  mode,
  currentSet,
  heroSets,
}: ExerciseHeroProps): React.JSX.Element {
  if (!hasSession) {
    return (
      <section className="hero" role="region" aria-label="Current exercise">
        <Card variant="elevated" elevation={2}>
          <CardContent className="px-6 py-8">
            <div className="panel-empty">No active session — start a set to begin.</div>
          </CardContent>
        </Card>
      </section>
    );
  }

  const named = exercise !== '—';
  const title = named ? exercise : 'Current exercise';
  const completed = heroSets.filter((r) => r.mode === 'completed').length;
  const lastRow = heroSets[heroSets.length - 1];
  const summaryReps = currentSet.repTarget ?? lastRow?.reps ?? 0;
  const summaryWeight = rnd(lastRow?.weightLbs ?? null) ?? 0;

  return (
    <section className="hero" role="region" aria-label={title}>
      {currentSet.active && (
        <div className="hero-live-strip" role="status" aria-live="polite">
          <span className="hero-live-dot" aria-hidden="true">
            ●
          </span>
          <span className="hero-live-label">Live</span>
          <span className="hero-live-item">{mode}</span>
          <span className="hero-live-item">
            <b>{currentSet.velocityLoss}</b> loss
          </span>
          <span className="hero-live-item">
            <b>{currentSet.latestPeakVelocity}</b> peak
          </span>
        </div>
      )}
      <div className="hero-card" aria-live="polite" aria-atomic="false">
        <ExerciseCard
          name={title}
          state="expanded"
          onToggle={() => undefined}
          summary={{ sets: completed, reps: summaryReps, weight: summaryWeight, unit: 'lbs' }}
          sets={heroSets.map(toSetRowProps)}
        />
      </div>
    </section>
  );
}
