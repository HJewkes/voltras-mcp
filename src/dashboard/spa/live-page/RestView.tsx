// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { type ReactElement } from 'react';
import { View, Text } from 'react-native';
import { useStore } from 'zustand';
import {
  RestTimer,
  TimerReadout,
  Metric,
  MetricGroup,
  ExerciseCardHeading,
  SetRow,
  SetTableHeader,
  Surface,
  useOnSurfaceColor,
  type MetricProps,
  type SetRowProps,
} from '@titan-design/react-ui';
import {
  activeCompletedSets,
  AUTO_ARM_BADGE_TEXT,
  autoArmedBadge,
  completedSetVerdict,
  deriveRecapPrescription,
  velocityLossPct,
  velocityRatios,
  type CompletedSet,
  type DashboardModel,
  type PrescriptionCells,
  type SessionModel,
  type SetPurpose,
} from './model';
import { setFatigueState } from './fatigue-state';
import { restBasisCaption } from './live-copy';
import { type MassUnit, formatMass } from './mass';
import { deriveCoachLineCaption, type CoachLineCaption } from './coach-line-model';
import { dashboardStore } from '../store';

/*
 * ⚠ PORTING RULE (see LivePage.tsx): layout via `style`, colour via the on-surface context.
 * The `<Surface>` root owns the charcoal plane AND seeds the on-surface colour context, so our
 * RN Text reads its colour through `useOnSurfaceColor` (literal hex) rather than a `text-*`
 * className — those do not resolve for raw RN Text in the standalone SPA (render black). Titan's
 * own components resolve colour to inline hex internally, so they are unaffected.
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
 *   - The countdown ring counts down the resolved rest (`session.restSec`, VW-441): the
 *     coach's, else the training-goal default `timer.start` uses, captioned as a default so
 *     it never reads as coach-set. With no session it falls back to the honest count-UP.
 */

/** Rest countdown ring diameter (px) — the across-the-room wall treatment. */
const RING_SIZE = 220;

/**
 * Height the coach caption always occupies (px), spoken line or not. RESERVED, not
 * conditional: a caption that appeared and vanished would shove the rest timer down and
 * back up mid-rest, and a timer that jumps is worse than a gap that is sometimes empty.
 */
const CAPTION_HEIGHT = 72;

/** A verdict metric to render, or null to hide it (no honest source). */
type MetricSpec = Pick<MetricProps, 'value' | 'unit' | 'label' | 'trend'> | null;

/** One logged set's row — the `done` arm of titan's `SetRowProps` union. */
type DoneSetRow = Extract<SetRowProps, { state: 'done' }>;

/**
 * The just-completed set of the ACTIVE exercise — the last set tagged with it (VW-50), or
 * null when nothing has been logged for it yet (pre-session / first set not closed).
 */
function justCompletedSet(model: DashboardModel): CompletedSet | null {
  const done = activeCompletedSets(model.session);
  return done.length > 0 ? done[done.length - 1] : null;
}

/**
 * The recap table's SET-cell marker for a non-working set (VW-260), or undefined for a
 * working set — `SetRow`'s own "no marker" case, so a working row's SET cell is unchanged
 * from before this field existed.
 */
function setTypeLabel(purpose: SetPurpose): string | undefined {
  switch (purpose) {
    case 'warmup':
      return 'WARM-UP';
    case 'probe':
      return 'PROBE';
    case 'technique':
      return 'TECHNIQUE';
    case 'working':
      return undefined;
  }
}

/**
 * The recap row's SET-cell marker: the set-purpose label above wins when the set has one
 * (it says something more specific than "the server opened this"); otherwise, an
 * auto-armed set (VW-265) gets the same "AUTO" text the live header badge uses, so the
 * lifter sees the same signal here once the set closes into rest. `undefined` for a
 * lifter-started working set — `SetRow`'s own "no marker" case.
 */
function setRowType(set: CompletedSet): string | undefined {
  return setTypeLabel(set.setPurpose) ?? (autoArmedBadge(set) ? AUTO_ARM_BADGE_TEXT : undefined);
}

/** The recap card's rows — one `done` row per logged set of the active exercise. */
function recapRows(model: DashboardModel, displayUnit: MassUnit): DoneSetRow[] {
  const { session } = model;
  return activeCompletedSets(session).map((set, i) => {
    // SetRow needs a number; under the mock adapter no weight cascade arrives → 0, the same
    // fallback the rail uses (never a fabricated load). Converted to the display unit (VW-63).
    const load = formatMass(set.weightLbs ?? 0, displayUnit);
    return {
      state: 'done',
      setNumber: i + 1,
      unit: load.unit,
      reps: set.repCount,
      weight: load.value,
      // Ratio-of-best, not raw m/s — SetRow's strip bands the same domain SetStrip does.
      velocities: velocityRatios(set.reps),
      // rpe intentionally omitted — the store has none and the specimen's value was invented.
      setType: setRowType(set),
    };
  });
}

/**
 * The finished set's verdict metrics — a 2×2 of the four readouts that matter at a glance:
 *   [ Reps ] [ Load ]
 *   [ Vloss] [ Fatg ]
 * Velocity/force detail (mean/peak MCV, peak force) is intentionally dropped — the wall
 * verdict is the top-line summary, not the full analytics. Entries the store cannot source
 * are null → hidden (a 1-rep set has no velocity loss, so Vloss/Fatg fall away honestly).
 */
function verdictMetrics(
  set: CompletedSet,
  session: SessionModel,
  displayUnit: MassUnit,
): MetricSpec[] {
  const loss = velocityLossPct(set.reps);
  const verdict =
    loss === null
      ? null
      : setFatigueState({ lossPct: loss, stop: set.fatigueStop, verdict: set.fatigueVerdict });
  // The load's UNIT is its label (e.g. value "20", label "lbs"/"kg") — no separate "Load"
  // caption. Converted to the client display unit (VW-63); the store stays lbs.
  const load = set.weightLbs !== null ? formatMass(set.weightLbs, displayUnit) : null;
  // Same rule `report.session_results`' "missed: X of Y" line uses (VW-262);
  // `no-target` (no plan attached, or an untargeted exercise) hides the tile.
  const target = completedSetVerdict(set, session);
  return [
    { value: String(set.repCount), label: 'Reps' },
    load !== null ? { value: String(load.value), label: load.unit } : null,
    loss !== null ? { value: `${Math.round(loss)}%`, label: 'Vel loss', trend: 'down' } : null,
    verdict !== null
      ? {
          value: verdict === 'threshold' ? 'MOD' : verdict === 'stop' ? 'HIGH' : 'LOW',
          label: 'Fatigue',
          trend: verdict === 'productive' ? 'up' : 'neutral',
        }
      : null,
    target !== 'no-target'
      ? { value: target === 'miss' ? 'MISS' : 'HIT', label: 'Target', trend: 'neutral' }
      : null,
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
  const color = useOnSurfaceColor('tertiary');
  return (
    <Text style={{ color, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>{children}</Text>
  );
}

/**
 * The rest countdown. A draining ring whenever a rest length resolved
 * ({@link DashboardModel.session.restSec}: the plan's, else the goal default, VW-441), with a
 * caption under it when that length is derived rather than coach-set. Without one (no
 * session) an honest count-UP readout. Hidden entirely before any rest clock is running.
 */
function RestCountdown({ model }: { model: DashboardModel }): ReactElement | null {
  const { session, restElapsedMs } = model;
  const info = nextSetInfo(model);
  // Hoisted above the early returns so the hook count stays stable (rules of hooks).
  const nextInfoColor = useOnSurfaceColor('secondary');
  const basisColor = useOnSurfaceColor('tertiary');
  if (session.restSec !== null) {
    const caption = session.restBasis === null ? null : restBasisCaption(session.restBasis);
    return (
      <View style={{ gap: 8, alignItems: 'center' }}>
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
        {caption && (
          <Text testID="rest-basis-caption" style={{ color: basisColor, fontSize: 13 }}>
            {caption}
          </Text>
        )}
      </View>
    );
  }
  if (restElapsedMs === null) return null;
  // No prescribed target → count up from the set close, the legacy RestTimerPanel behaviour.
  return (
    <View style={{ gap: 8 }}>
      <Eyebrow>REST</Eyebrow>
      <TimerReadout mode="up" elapsedMs={restElapsedMs} running />
      {info && <Text style={{ color: nextInfoColor, fontSize: 13 }}>{info}</Text>}
    </View>
  );
}

/**
 * The last thing the trainer said (VW-289), in a box whose height is reserved either way.
 *
 * Pure props, like `IsometricVerdictCard`: whether there is anything to caption is
 * {@link deriveCoachLineCaption}'s decision, made once by {@link RestView} off the store.
 */
export function CoachCaption({ caption }: { caption: CoachLineCaption | null }): ReactElement {
  const textColor = useOnSurfaceColor('primary');
  const labelColor = useOnSurfaceColor('tertiary');
  return (
    <View style={{ height: CAPTION_HEIGHT }}>
      {caption && (
        <Surface
          raise={1}
          style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingHorizontal: 16,
          }}
          testID="coach-caption"
        >
          <Text style={{ color: labelColor, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>
            {caption.label}
          </Text>
          <Text
            numberOfLines={2}
            style={{ color: textColor, flex: 1, fontSize: 18, lineHeight: 22 }}
          >
            {caption.text}
          </Text>
        </Surface>
      )}
    </View>
  );
}

/**
 * The recap card: the prescription heading over the logged `done` rows.
 *
 * Composed from titan's standalone parts rather than `ExerciseCard` (VMCP-03.05).
 * `ExerciseCardProps.summary.weight` is `number`, and the card renders `summary?.weight ?? 0`
 * — so an unknown load can only reach that heading as a fabricated `0 lbs`. The parts titan
 * exports for exactly this (`ExerciseCardHeading` is documented as standalone, `SetTableHeader`
 * as extracted from the expanded card for reuse) take `load: number | string`, so the gap can
 * read as a gap. Same visual chrome as the expanded card.
 */
function RecapCard({
  name,
  heading,
  rows,
  tempo,
}: {
  name: string;
  heading: PrescriptionCells;
  rows: DoneSetRow[];
  tempo?: [number, number, number, number];
}): ReactElement {
  return (
    <View className="bg-surface-elevated border-hairline" style={{ borderWidth: 1 }}>
      <ExerciseCardHeading
        name={name}
        sets={heading.sets}
        reps={heading.reps}
        load={heading.load}
        unit={heading.unit}
        {...(tempo ? { tempo } : {})}
        indicator="velocity-loss"
        setStates={rows.map((row) => ({ status: 'done' as const, velocities: row.velocities }))}
        testID="recap-card-heading"
      />
      <View style={{ borderTopWidth: 1 }}>
        <SetTableHeader unit={heading.unit} showPrevious={false} />
        {rows.map((row, i) => (
          // `SetRow` has no muted variant of its own `done` state (VW-260) — `setType` (set
          // above) already labels a non-working row, and this opacity wrapper is the extra
          // "look muted, not just labelled" cue, applied from OUTSIDE the titan component
          // rather than reimplementing it. An AUTO-only marker (VW-265) is excluded: an
          // auto-armed set is a real working set (VMCP-02.84) and must not read as muted.
          <View
            key={i}
            style={
              row.setType !== undefined && row.setType !== AUTO_ARM_BADGE_TEXT
                ? { opacity: 0.55 }
                : undefined
            }
          >
            <SetRow {...row} />
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Lab specimen PORT — the REST stage of the North Star wall dashboard, store-fed.
 *
 * A between-sets read-out: the rest countdown, a recap of the set just finished, and the
 * finished set's verdict metrics. Rendered by {@link LivePage} whenever no set is streaming.
 */
export function RestView({
  model,
  displayUnit = 'lbs',
}: {
  model: DashboardModel;
  /** Client DISPLAY unit for weight / load / peak-force readouts (VW-63). Store stays lbs. */
  displayUnit?: MassUnit;
}): ReactElement {
  const { session } = model;
  // SSE-fed independently of `model` (VW-289), like the isometric walkthrough a level up:
  // the store's 1 s tick is what expires the caption, so no timer lives in the component.
  const coachLine = useStore(dashboardStore, (s) => s.coachLine);
  const nowMs = useStore(dashboardStore, (s) => s.nowMs);
  const set = justCompletedSet(model);
  const rows = recapRows(model, displayUnit);
  const metrics = set
    ? verdictMetrics(set, session, displayUnit).filter(
        (m): m is NonNullable<MetricSpec> => m !== null,
      )
    : [];
  const heading = deriveRecapPrescription(session, rows.length, displayUnit);

  return (
    // The rest stage's charcoal plane (surface-base) + on-surface colour context for the
    // eyebrows/next-set text below — same charcoal it sat on before, now context-seeded.
    <Surface level="base" style={{ flex: 1, flexDirection: 'row', padding: 20, gap: 20 }}>
      {/* left: the countdown + the just-completed exercise recap. */}
      <View style={{ flex: 2, gap: 20 }}>
        <CoachCaption caption={deriveCoachLineCaption({ line: coachLine, nowMs })} />
        <RestCountdown model={model} />
        {rows.length > 0 && (
          <View style={{ gap: 8 }}>
            <Eyebrow>SET JUST COMPLETED</Eyebrow>
            <RecapCard
              name={session.exerciseName}
              heading={heading}
              rows={rows}
              {...(session.tempo ? { tempo: session.tempo } : {})}
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
    </Surface>
  );
}
