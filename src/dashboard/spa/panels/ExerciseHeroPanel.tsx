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
 * Set rows + the header summary are produced by the shared view-model mappers
 * (`toSetRowProps`, `toExerciseSummary`) from canonical `WorkoutSetView`s — the
 * same mappers the mobile app will reuse, so both surfaces derive RPE / velocity
 * identically. Data-shape gaps closed there (rather than avoided): peak velocity
 * rides SetRow's built-in per-row VelocityStrip (`velocities`); the prior set
 * fills PREV; RPE is a WA velocity-loss estimate (em-dash when inestimable). Mode
 * is a per-exercise constant surfaced in the live-status line, not per row — a
 * slim strip carrying the dashboard's across-the-room signals (velocity-loss %,
 * latest peak).
 *
 * a11y (preserves Phase 5): ARIA region named for the exercise; the set list is
 * aria-live="polite" so a completed set announces once (row count changes only on
 * set close — see reduceSnapshot). NDA: renders adapter view-models only.
 */
import {
  Card,
  CardContent,
  DeviationBar,
  ExerciseCard,
  VelocityStrip,
  WorkoutCard,
} from '@titan-design/react-ui';
import type { CurrentSetView } from '../adapter';

/** Next planned workout for the idle preview, matching `/api/next-workout`. */
export interface NextWorkoutView {
  name: string;
  date: string;
  totalSets: number;
  muscleGroups: Array<{ group: string; label: string }>;
  unit: 'lbs';
}
import {
  deriveExerciseE1RM,
  deriveTempo,
  formatPrescription,
  isNewE1RM,
  toExerciseSummary,
  toSetRowProps,
  weightDeviationPct,
  type PrescriptionView,
  type WorkoutSetView,
} from '../view-model/mappers';

export interface ExerciseHeroProps {
  /** Active-session exercise name; `'—'` when idle. */
  exercise: string;
  hasSession: boolean;
  /** Per-exercise training mode (e.g. "weight Training"), for the status line. */
  mode: string;
  /** Live callout signals (velocity-loss %, latest peak) for the active set. */
  currentSet: CurrentSetView;
  /** Completed sets + the active set, ascending, as canonical set views. */
  heroSets: WorkoutSetView[];
  /** Best estimated 1RM in this exercise's prior history, for PR detection. Null when none. */
  historyBestE1rm: number | null;
  /** Next planned workout for the idle preview; null when no plan / none pending. */
  nextWorkout: NextWorkoutView | null;
  /** Prescribed targets for the active exercise; null when no plan is attached. */
  prescription: PrescriptionView | null;
}

export function ExerciseHeroPanel({
  exercise,
  hasSession,
  mode,
  currentSet,
  heroSets,
  historyBestE1rm,
  nextWorkout,
  prescription,
}: ExerciseHeroProps): React.JSX.Element {
  if (!hasSession) {
    return (
      <section className="hero" role="region" aria-label="Current exercise">
        {nextWorkout ? (
          // Idle time becomes program context: the next unassigned workout from
          // the active program, as a titan WorkoutCard.
          <div className="hero-next-workout">
            <div className="hero-next-label">Up next</div>
            <WorkoutCard
              name={nextWorkout.name}
              date={nextWorkout.date}
              status="upcoming"
              muscleGroups={nextWorkout.muscleGroups}
              totalSets={nextWorkout.totalSets}
              unit={nextWorkout.unit}
            />
          </div>
        ) : (
          <Card variant="elevated" elevation={2}>
            <CardContent className="px-6 py-8">
              <div className="panel-empty">No active session — start a set to begin.</div>
            </CardContent>
          </Card>
        )}
      </section>
    );
  }

  const named = exercise !== '—';
  const title = named ? exercise : 'Current exercise';
  const summary = toExerciseSummary(heroSets, currentSet.repTarget);
  const e1rm = deriveExerciseE1RM(heroSets);
  const isPR = isNewE1RM(e1rm?.value, historyBestE1rm);
  const tempo = deriveTempo(heroSets);
  const prescriptionText = formatPrescription(prescription);
  const activeWeightLbs = heroSets[heroSets.length - 1]?.weightLbs ?? null;
  const weightDeviation = weightDeviationPct(activeWeightLbs, prescription?.weightLbs);

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
      {currentSet.active && currentSet.velocitiesMps.length > 0 && (
        // Expanded per-rep velocity chart for the LIVE set — the same titan
        // VelocityStrip organism the mobile app uses, at full/expanded variant so
        // the zone-colored bars + velocity-loss read across the room. The nested
        // SetRow strips stay mini; this is the active-set close-up.
        <div className="hero-velocity" aria-label="Live set velocity by rep">
          <VelocityStrip velocities={currentSet.velocitiesMps} variant="full" expanded showInfo />
        </div>
      )}
      {currentSet.active && weightDeviation !== null && (
        // Working weight vs the attached plan's prescribed weight — "on plan" at
        // a glance via titan DeviationBar (positive = heavier than planned).
        <div
          className="hero-deviation"
          aria-label={`Working weight vs plan: ${weightDeviation > 0 ? '+' : ''}${weightDeviation}%`}
        >
          <span className="hero-deviation-label">vs plan</span>
          <DeviationBar deviation={weightDeviation} width={160} />
          <span className="hero-deviation-value">
            {weightDeviation === 0
              ? 'on plan'
              : `${weightDeviation > 0 ? '+' : ''}${weightDeviation}%`}
          </span>
        </div>
      )}
      <div className="hero-card" aria-live="polite" aria-atomic="false">
        <ExerciseCard
          name={title}
          state="expanded"
          onToggle={() => undefined}
          summary={summary}
          e1rm={e1rm ?? undefined}
          isPR={isPR}
          tempo={tempo ?? undefined}
          prescription={prescriptionText ?? undefined}
          sets={heroSets.map(toSetRowProps)}
        />
      </div>
    </section>
  );
}
