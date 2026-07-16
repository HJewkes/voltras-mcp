// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { type ReactElement } from 'react';
import { View, Text } from 'react-native';
import {
  RestTimer,
  TimerReadout,
  Metric,
  MetricGroup,
  ExerciseCard,
  type MetricProps,
  type SetRowProps,
} from '@titan-design/react-ui';
import {
  activeCompletedSets,
  meanVelocity,
  peakVelocity,
  velocityLossPct,
  verdictFromLoss,
  type CompletedSet,
  type DashboardModel,
} from './model';

/*
 * ⚠ PORTING RULE (see LivePage.tsx): layout via `style`, colour via className.
 *
 * PORTED from titan's `Lab/North Star` RestView specimen, now STORE-FED. The specimen read
 * everything off the mid-set `live` overlay (its per-rep velocities, peak force, ROM, live
 * velocity loss). In the real rest state that overlay is null BY DEFINITION — no set is
 * streaming — so this recap sources the JUST-COMPLETED set from `session.completedSets`
 * instead. Fields the store cannot supply once the set closes are HIDDEN, never faked:
 *   - Peak force: NOW sourced — `CompletedSet.peakForceLbs` folds the set's max concentric
 *     force at set-close (VW-61), so the tile survives into rest (the live overlay's
 *     `peakForce`/VW-45 is gone the instant rest begins). Hidden when the fold is null.
 *   - Avg ROM: `CompletedSet` carries no rom → still omitted.
 *   - RPE: the specimen fabricated `8 + i*0.5`; the store has no RPE → omitted from rows.
 *   - The countdown ring needs a rest TARGET (`session.restSec`/VW-51); when the coach left
 *     it unset we do NOT invent one (the lab hardcoded 120s) — we fall back to the honest
 *     count-UP the legacy `RestTimerPanel` shows.
 */

const NO_VALUE = '—';
/** Rest countdown ring diameter (px) — the across-the-room wall treatment. */
const RING_SIZE = 220;

/** A verdict metric to render, or null to hide it (no honest source). */
type MetricSpec = Pick<MetricProps, 'value' | 'unit' | 'label' | 'trend'> | null;

/**
 * The just-completed set of the ACTIVE exercise — the last set tagged with it (VW-50), or
 * null when nothing has been logged for it yet (pre-session / first set not closed).
 */
function justCompletedSet(model: DashboardModel): CompletedSet | null {
  const done = activeCompletedSets(model.session);
  return done.length > 0 ? done[done.length - 1] : null;
}

/** The recap card's rows — one `done` row per logged set of the active exercise. */
function recapRows(model: DashboardModel): SetRowProps[] {
  const { session } = model;
  return activeCompletedSets(session).map((set, i) => ({
    state: 'done',
    setNumber: i + 1,
    unit: session.unit,
    reps: set.repCount,
    // SetRow needs a number; under the mock adapter no weight cascade arrives → 0, the same
    // fallback the rail uses (never a fabricated load).
    weight: set.weightLbs ?? 0,
    velocities: set.reps,
    // rpe intentionally omitted — the store has none and the specimen's value was invented.
  }));
}

/** The finished set's verdict metrics; entries the store cannot source are null → hidden. */
function verdictMetrics(set: CompletedSet): MetricSpec[] {
  const mean = meanVelocity(set.reps);
  const peak = peakVelocity(set.reps);
  const loss = velocityLossPct(set.reps);
  const verdict = loss === null ? null : verdictFromLoss(loss);
  return [
    set.reps.length > 0 ? { value: mean.toFixed(2), unit: 'm/s', label: 'Mean con' } : null,
    peak !== null ? { value: peak.toFixed(2), unit: 'm/s', label: 'Peak con' } : null,
    loss !== null ? { value: `${Math.round(loss)}%`, label: 'Vel loss', trend: 'down' } : null,
    { value: String(set.repCount), label: 'Reps' },
    set.weightLbs !== null ? { value: String(set.weightLbs), unit: 'lbs', label: 'Load' } : null,
    verdict !== null
      ? {
          value: verdict === 'threshold' ? 'MOD' : verdict === 'stop' ? 'HIGH' : 'LOW',
          label: 'Fatigue',
          trend: verdict === 'productive' ? 'up' : 'neutral',
        }
      : null,
    // Peak force: the just-closed set's max concentric force (VW-61), folded at
    // set-close so it survives into rest (the live overlay's `peakForce` is gone by
    // now). Hidden when the store logged no force — never faked.
    set.peakForceLbs !== null
      ? { value: String(Math.round(set.peakForceLbs)), unit: 'lbs', label: 'Peak force' }
      : null,
    // Avg ROM: no `CompletedSet` source once the set closes → still hidden, not faked.
  ];
}

/** Chunk a flat list into fixed-size groups (the specimen's MetricGroup pairs). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The honest "next up" line, or undefined when the store can't name one. Same exercise while
 * sets remain; otherwise the next planned exercise (VW-49). Never invented.
 */
function nextSetInfo(model: DashboardModel): string | undefined {
  const { session } = model;
  const doneCount = activeCompletedSets(session).length;
  if (session.plannedSets !== null && doneCount < session.plannedSets) {
    return `Next · ${session.exerciseName} · set ${doneCount + 1} of ${session.plannedSets}`;
  }
  const activeIndex = session.plannedExercises.findIndex((e) => e.active);
  const next = activeIndex >= 0 ? session.plannedExercises[activeIndex + 1] : undefined;
  if (next) return `Next · ${next.name} · set 1 of ${next.plannedSets}`;
  return undefined;
}

/** A section eyebrow label — the specimen's tertiary all-caps caption. */
function Eyebrow({ children }: { children: string }): ReactElement {
  return (
    <Text
      className="text-text-tertiary"
      style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1 }}
    >
      {children}
    </Text>
  );
}

/**
 * The rest countdown. A ring (draining) when the plan prescribes a rest target
 * ({@link DashboardModel.session.restSec}); otherwise an honest count-UP readout — we never
 * invent a target just to draw a ring. Hidden entirely before any rest clock is running.
 */
function RestCountdown({ model }: { model: DashboardModel }): ReactElement | null {
  const { session, restElapsedMs } = model;
  const info = nextSetInfo(model);
  if (session.restSec !== null) {
    return (
      <RestTimer
        variant="ring"
        size={RING_SIZE}
        totalSeconds={session.restSec}
        elapsedMs={restElapsedMs ?? 0}
        visible
        displayOnly
        nextSetInfo={info}
        onSkip={() => {}}
        onAddTime={() => {}}
      />
    );
  }
  if (restElapsedMs === null) return null;
  // No prescribed target → count up from the set close, the legacy RestTimerPanel behaviour.
  return (
    <View style={{ gap: 8 }}>
      <Eyebrow>REST</Eyebrow>
      <TimerReadout mode="up" elapsedMs={restElapsedMs} running />
      {info && (
        <Text className="text-text-secondary" style={{ fontSize: 13 }}>
          {info}
        </Text>
      )}
    </View>
  );
}

/**
 * Lab specimen PORT — the REST stage of the North Star wall dashboard, store-fed.
 *
 * A between-sets read-out: the rest countdown, a recap of the set just finished, and the
 * finished set's verdict metrics. Rendered by {@link LivePage} whenever no set is streaming.
 */
export function RestView({ model }: { model: DashboardModel }): ReactElement {
  const { session } = model;
  const set = justCompletedSet(model);
  const rows = recapRows(model);
  const metrics = set
    ? verdictMetrics(set).filter((m): m is NonNullable<MetricSpec> => m !== null)
    : [];

  return (
    <View style={{ flex: 1, flexDirection: 'row', padding: 20, gap: 20 }}>
      {/* left: the countdown + the just-completed exercise recap. */}
      <View style={{ flex: 2, gap: 20 }}>
        <RestCountdown model={model} />
        {rows.length > 0 && (
          <View style={{ gap: 8 }}>
            <Eyebrow>SET JUST COMPLETED</Eyebrow>
            <ExerciseCard
              name={session.exerciseName}
              expanded
              summary={{
                sets: session.plannedSets ?? rows.length,
                reps: session.targetReps ?? NO_VALUE,
                weight: session.weightLbs ?? 0,
                unit: session.unit,
              }}
              {...(session.tempo ? { tempo: session.tempo } : {})}
              indicator="velocity-loss"
              sets={rows}
            />
          </View>
        )}
      </View>

      {/* right: the finished set's verdict (only the metrics the store can honestly source). */}
      {metrics.length > 0 && (
        <View style={{ flex: 1, gap: 24 }}>
          <View style={{ gap: 6 }}>
            <Eyebrow>SET VERDICT</Eyebrow>
            {chunk(metrics, 2).map((pair, i) => (
              <MetricGroup key={i}>
                {pair.map((m, j) => (
                  <Metric key={j} size="md" {...m} />
                ))}
              </MetricGroup>
            ))}
          </View>
        </View>
      )}
    </View>
  );
}
