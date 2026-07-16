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
 * Set rows + the header summary are wired here (`toSetRowProps`,
 * `toExerciseSummary`) from canonical `WorkoutSetView`s: exact derivations come
 * from `@voltras/workout-analytics` and the titan components round/band/format
 * for display (the model↔render split). Mobile wires its own WA data into the
 * same titan components identically. Data-shape gaps closed here: peak velocity
 * rides SetRow's built-in per-row VelocityStrip (`velocities`); the prior set
 * fills PREV; RPE is a WA velocity-loss estimate (em-dash when inestimable). Mode
 * is a per-exercise constant surfaced in the live-status line, not per row — a
 * slim strip carrying the dashboard's across-the-room signals (velocity-loss %,
 * latest peak).
 *
 * a11y (preserves Phase 5): ARIA region named for the exercise; the set list is
 * aria-live="polite" so a completed set announces once (row count changes only on
 * set close — see reduceSnapshot). Confidentiality: renders adapter view-models only.
 */
import {
  Card,
  CardContent,
  DeviationBar,
  ExerciseCard,
  FatigueMeter,
  LiveAuraFrame,
  StatusPill,
  TempoDisplay,
  VelocityStrip,
  WorkoutCard,
  formatPrescription,
  formatSignedPct,
} from '@titan-design/react-ui';
import { getSetTempoSeconds, weightDeviationRatio } from '@voltras/workout-analytics';
import { type CurrentSetView, type PrescriptionView, type WorkoutSetView } from '../adapter';
import {
  toAutoRegStatus,
  toExerciseIsPR,
  toExerciseSummary,
  toLiveTempoSeconds,
  toSetRowProps,
} from './exercise-hero-view';
import { LiveReadout } from './LiveReadout';

/** Next planned workout for the idle preview, matching `/api/next-workout`. */
export interface NextWorkoutView {
  name: string;
  date: string;
  totalSets: number;
  muscleGroups: Array<{ group: string; label: string }>;
  unit: 'lbs';
}
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
  const isPR = toExerciseIsPR(heroSets, historyBestE1rm);
  const lastSet = heroSets[heroSets.length - 1];
  const tempo = getSetTempoSeconds({ reps: lastSet?.reps ?? [] });
  // Live cadence for the in-progress set — a dedicated across-the-room TempoDisplay
  // dial, mirroring how the live VelocityStrip is surfaced above the card in
  // addition to the card's own compact per-set values.
  const liveTempo = toLiveTempoSeconds(heroSets.find((v) => v.kind === 'active') ?? null);
  const prescriptionText = formatPrescription(prescription);
  const activeWeightLbs = lastSet?.weightLbs ?? null;
  // Exact signed ratio (e.g. 0.09). DeviationBar takes the ratio directly; the
  // label formats it as a percent via titan. (The former mapper handed a
  // pre-scaled percentage to DeviationBar, which expects a ratio — this also
  // corrects the dot position.)
  const weightDeviation = weightDeviationRatio(activeWeightLbs, prescription?.weightLbs);
  // Live auto-regulation verdict (productive/threshold/stop) from the set's
  // velocity loss — drives the StatusPill verdict, the FatigueMeter needle, and
  // the LiveAuraFrame flood so the across-the-room signal is coherent.
  const autoReg = toAutoRegStatus(currentSet.velocityLossPct);

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
          {autoReg && <StatusPill status={autoReg} />}
          {/* VMCP-01.59: sub-second live phase/velocity from the SSE overlay,
              layered onto the existing strip. Renders only when the stream is
              connected; absent it, the strip is unchanged (poll-only). */}
          <LiveReadout />
        </div>
      )}
      {currentSet.active && (
        // Live close-up, wrapped in the coaching-category flood frame: the
        // surface washes amber at VL20 and red at VL28+ so a lifter across the
        // room feels the auto-reg verdict without reading a number. Quiet
        // (no flood) while productive.
        <LiveAuraFrame category={autoReg ?? 'productive'} className="hero-aura">
          {currentSet.velocitiesMps.length > 0 && (
            // Expanded per-rep velocity chart for the LIVE set — the same titan
            // VelocityStrip organism the mobile app uses, at the expanded variant
            // so the zone-colored bars + velocity-loss read across the room.
            <div className="hero-velocity" aria-label="Live set velocity by rep">
              <VelocityStrip
                velocities={currentSet.velocitiesMps}
                variant="expanded"
                expanded
                showInfo
              />
            </div>
          )}
          {liveTempo !== null && (
            // Live per-rep cadence — titan's TempoDisplay dial (eccentric ·
            // pause-bottom · concentric · pause-top), colored so the most recent
            // rep's tempo reads across the room.
            <div
              className="hero-tempo"
              aria-label="Live set tempo, eccentric pause concentric pause"
            >
              <span className="hero-tempo-label">Tempo</span>
              <TempoDisplay tempo={liveTempo} showInfo />
            </div>
          )}
          {currentSet.velocityLossPct !== null && (
            // Fatigue auto-regulation — titan's needle-over-zoned-gradient
            // FatigueMeter (VL10/20/30/stop), driven by the same live velocity
            // loss as the StatusPill verdict and the flood above.
            <div
              className="hero-fatigue"
              aria-label={`Fatigue auto-regulation, ${currentSet.velocityLoss} velocity loss`}
            >
              <span className="hero-fatigue-label">Fatigue</span>
              <FatigueMeter value={currentSet.velocityLossPct} />
            </div>
          )}
        </LiveAuraFrame>
      )}
      {currentSet.active && weightDeviation !== null && (
        // Working weight vs the attached plan's prescribed weight — "on plan" at
        // a glance via titan DeviationBar (positive = heavier than planned).
        <div
          className="hero-deviation"
          aria-label={`Working weight vs plan: ${formatSignedPct(weightDeviation)}`}
        >
          <span className="hero-deviation-label">vs plan</span>
          <DeviationBar deviation={weightDeviation} width={160} />
          <span className="hero-deviation-value">
            {weightDeviation === 0 ? 'on plan' : formatSignedPct(weightDeviation)}
          </span>
        </div>
      )}
      <div className="hero-card" aria-live="polite" aria-atomic="false">
        <ExerciseCard
          name={title}
          expanded
          summary={summary}
          isPR={isPR}
          tempo={tempo ?? undefined}
          prescription={prescriptionText ?? undefined}
          sets={heroSets.map(toSetRowProps)}
        />
      </div>
    </section>
  );
}
