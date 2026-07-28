// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { useCallback, useState } from 'react';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import {
  LiveFatiguePanel,
  SessionRail,
  Surface,
  alpha,
  getSemanticColors,
  useOnSurfaceColor,
} from '@titan-design/react-ui';
import { ExerciseHeader, LiveView } from './LiveView';
import { DivergingLiveStage } from './DivergingLiveStage';
import { hasBoundSide } from './diverging-stage-model';
import { RestView } from './RestView';
import { EmptyLiveView } from './EmptyLiveView';
import {
  deriveRailExercises,
  deriveRailMetrics,
  stageIsEmpty,
  type DashboardModel,
  type LiveDashboardModel,
} from './model';
import { FATIGUE_PANEL_CHROME, FATIGUE_PANEL_FALLBACK_BODY } from './panel-geometry';
import type { DivergingHeroModel, LimbAsymmetry, LiveFatigueModel } from './fatigue-model';
import { type MassUnit } from './mass';

// Semantic reads for the corner UnitToggle's own chrome — its translucent (alpha) overlay
// ground, active-segment plane, and border. These are NOT on-surface text roles, so they come
// from the token map rather than `useOnSurfaceColor`; the toggle's text uses the hook.
const t = getSemanticColors('dark');

/** localStorage key for the client's chosen weight/force display unit (VW-63). */
const DISPLAY_UNIT_KEY = 'voltras.live.displayUnit';

/** Read the persisted display-unit preference; lbs unless kg was explicitly stored. SSR-safe. */
function readStoredUnit(): MassUnit {
  if (typeof window === 'undefined') return 'lbs';
  return window.localStorage.getItem(DISPLAY_UNIT_KEY) === 'kg' ? 'kg' : 'lbs';
}

/**
 * The DISPLAY unit preference (VW-63) — a CLIENT choice, independent of the model's source
 * unit (always lbs). Persisted to localStorage so a wall keeps its unit across reloads. This
 * NEVER mutates the store/model; conversion happens at each readout.
 */
function useDisplayUnit(): [MassUnit, (unit: MassUnit) => void] {
  const [unit, setUnit] = useState<MassUnit>(readStoredUnit);
  const choose = useCallback((next: MassUnit) => {
    setUnit(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(DISPLAY_UNIT_KEY, next);
  }, []);
  return [unit, choose];
}

/** A subtle corner segmented control toggling the wall's weight/force display unit (VW-63). */
function UnitToggle({ unit, onChange }: { unit: MassUnit; onChange: (unit: MassUnit) => void }) {
  const units: MassUnit[] = ['lbs', 'kg'];
  const activeText = useOnSurfaceColor('primary');
  const inactiveText = useOnSurfaceColor('tertiary');
  return (
    <View
      style={{
        position: 'absolute',
        bottom: 14,
        right: 18,
        zIndex: 10,
        flexDirection: 'row',
        borderRadius: 8,
        overflow: 'hidden',
        borderWidth: 1,
        // `border-default` was deleted in titan 0.12.0 — solid dark borders are
        // gone and separation is the alpha hairline family's job now. Same role,
        // and self-normalizing, so it holds up on whatever plane this floats over.
        borderColor: t['hairline-default'],
        backgroundColor: alpha(t['surface-overlay'], 0.85),
      }}
    >
      {units.map((u) => {
        const active = u === unit;
        return (
          <Pressable
            key={u}
            onPress={() => onChange(u)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 5,
              backgroundColor: active ? t['surface-raised'] : 'transparent',
            }}
          >
            <Text
              style={{
                color: active ? activeText : inactiveText,
                fontSize: 11,
                fontWeight: '700',
                letterSpacing: 1.5,
              }}
            >
              {u.toUpperCase()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export type LivePageVariant = 'live' | 'live-dual';

/**
 * ⚠ PORTING RULE: LAYOUT GOES THROUGH `style`, NEVER A TAILWIND CLASS.
 *
 * The lab original expressed layout as `className="flex-1 flex-row"`, which works in
 * titan's Storybook (nativewind's babel transform turns className into styles). This app
 * has no such transform — it generates titan's Tailwind CSS instead and lets
 * react-native-web consume the class strings. That works for COLOUR
 * (`bg-surface-base` has nothing to fight) but silently loses for LAYOUT: RNW injects its
 * own base View rules (`flex-direction: column; flex-shrink: 0; flex-basis: auto`) at the
 * SAME CSS specificity and LATER in the sheet, so `.flex-row`/`.flex-1` never win. The
 * failure is silent — the page renders, just stacked and collapsed to its min width.
 *
 * Colour classNames are fine and stay. Layout must be a `style` prop.
 */

/** Floor the live panel around phone width so it stops collapsing on a narrow window. */
const PANEL_MIN_WIDTH = 390;
/** Rail title fallback — a generic label, never an invented session name (VW-43). */
const UNTITLED_SESSION = 'Session';

// The panel's own geometry (chrome, body default, column widths) now lives in
// `panel-geometry.ts` — the IDLE stage prefigures this exact skeleton and the two must not
// drift apart. Imported above.

/**
 * The single-Voltra live stage (VMCP-05.02): titan's `LiveFatiguePanel` — the velocity
 * hero and the athlete-level fatigue card (RPE + verdict lights + ROM progression +
 * ghost-spark) as one aura-flooded organism.
 *
 * No `header` prop: the exercise identity and targets are the PAGE-level
 * {@link ExerciseHeader} above this, and the panel's own lite header would duplicate it.
 *
 * The panel sizes its body in fixed px rather than flexing, so the stage height is
 * measured and fed down — otherwise it renders at titan's 508 default and either
 * underfills a wall display or overflows a short one.
 */
function SingleFatigueStage({
  model,
  fatigue,
}: {
  model: LiveDashboardModel;
  fatigue: LiveFatigueModel;
}) {
  const [stageH, setStageH] = useState(0);
  const bodyHeight =
    stageH > 0 ? Math.max(0, stageH - FATIGUE_PANEL_CHROME) : FATIGUE_PANEL_FALLBACK_BODY;
  const { live, session } = model;
  return (
    <View
      style={{ flex: 1 }}
      onLayout={(e: LayoutChangeEvent) => setStageH(e.nativeEvent.layout.height)}
    >
      <LiveFatiguePanel
        model={fatigue}
        // The hero's own source — per-rep MEAN concentric velocity, not on the fatigue
        // model. `liveRepIndex` marks the rep in progress as the last one streamed.
        velocity={{
          velocities: live.repVelocities,
          targetReps: session.targetReps ?? undefined,
          liveRepIndex: live.repVelocities.length - 1,
        }}
        bodyHeight={bodyHeight}
      />
    </View>
  );
}

export interface LivePageProps {
  /** Which stage to show in the main region. */
  variant?: LivePageVariant;
  /** The dashboard store snapshot, projected by `panels/live-view.ts`. */
  model: DashboardModel;
  /**
   * The diverging dual hero (VMCP-04.05), projected by `mapStoreToDivergingHeroModel`.
   * Required for `variant === 'live-dual'`; ignored otherwise. A null SIDE is an unbound
   * slot and renders an awaiting wing, never a fabricated or mirrored limb.
   */
  hero?: DivergingHeroModel;
  /**
   * The L/R imbalance callout, off `mapStoreToFatigueModel`. Null whenever it cannot be
   * computed honestly, in which case the stage simply declines to draw it.
   */
  asymmetry?: LimbAsymmetry | null;
  /**
   * The athlete-level fatigue read-model, off `mapStoreToFatigueModel`. Drives the single
   * stage's {@link LiveFatiguePanel}. `null` when no set is active — the stage switch has
   * already fallen through to rest/empty by then, so the panel never sees it.
   */
  fatigue?: LiveFatigueModel | null;
}

/**
 * The North Star wall-dashboard CONTENT (mounts inside `DashboardShell`'s children slot):
 * the persistent {@link SessionRail} context beside the live stage.
 *
 * PORTED from titan's `Lab/North Star` specimen, now store-fed. One deliberate reduction
 * against the lab original, because the store cannot honestly supply the data:
 *   - The REST stage IS now ported ({@link RestView}, VW-60), but only shows what the store
 *     can source between sets: the recap comes from the completed-set log (the `live`
 *     overlay is null while resting), peak force / ROM are hidden (no `CompletedSet`
 *     source), and the countdown ring draws only when a rest TARGET is prescribed (VW-51) —
 *     otherwise it falls back to the honest count-up, never the lab's hardcoded 120s.
 *   - `live-dual` renders the DIVERGING hero ({@link DivergingLiveStage}, VMCP-04.05) off
 *     real per-slot telemetry (VW-71). An unbound slot shows an honest awaiting wing, never
 *     a fabricated or mirrored limb. It replaced a stacked two-`LiveView` stage that
 *     duplicated every shared read-out and scrolled on a short wall.
 *
 * The rail footer pace read-out is intentionally OMITTED (no store field).
 */
export function LivePage({ variant = 'live', model, hero, asymmetry, fatigue }: LivePageProps) {
  const [displayUnit, setDisplayUnit] = useDisplayUnit();
  const exercises = deriveRailExercises(model, displayUnit);
  const metrics = deriveRailMetrics(model, displayUnit);
  const completedSets = model.session.completedSets.length;
  const isLive = model.live !== null;

  return (
    // The page's charcoal plane (surface-base) and the on-surface colour context root: every
    // stage below (header, live/rest/empty) resolves its text colour from this Surface instead
    // of grabbing a token. Layout still via `style` — see the PORTING RULE above.
    <Surface level="base" style={{ flex: 1, flexDirection: 'row' }}>
      <SessionRail
        title={model.session.title ?? UNTITLED_SESSION}
        exercises={exercises}
        // Fractional credit for the set in progress — the lab's 0.75 stood in for
        // "part-way through"; with real reps we know how far.
        setsDone={completedSets + liveSetProgress(model)}
        running={isLive}
        width={272}
        // Session rollup tiles (Volume / Load), folded from the exercise-tagged set log
        // (VW-52). Undefined before the first set closes, so the header hides them rather
        // than showing zeros. No Fatigue tile — no honest session-wide signal to source it.
        metrics={metrics ?? undefined}
      />
      {/* The lab hardcoded 76% / 7.3k / MOD here; the tiles above are the real rollup. */}

      {/* Panel floors at ~phone width so the live view stops collapsing; rail-aware
          breakpoints below this are a later pass. */}
      <View style={{ flex: 1, minWidth: PANEL_MIN_WIDTH }}>
        {/* workout title + targets + the active exercise's set strip — page-level, always
            visible, independent of single/dual. */}
        <ExerciseHeader model={model} displayUnit={displayUnit} />
        <View style={{ flex: 1 }}>
          {variant === 'live-dual' && model.live !== null && hero && hasBoundSide(hero) ? (
            // Dual + a set streaming + at least one BOUND slot ⇒ the diverging hero
            // (VMCP-04.05). Two guards worth keeping straight:
            //   - a LIVE set, because rest and idle are SESSION-level rather than
            //     per-limb, so both variants fall through to the same stages below
            //     instead of each growing a bilateral copy of them;
            //   - a bound side, because an ordinary single-Voltra session runs on the
            //     `primary` slot and leaves BOTH sides null — drawing the diverging
            //     stage there gives an empty axis and an "awaiting both" note while the
            //     athlete is mid-set and the single view would have shown the lift.
            <DivergingLiveStage
              model={model as LiveDashboardModel}
              hero={hero}
              asymmetry={asymmetry ?? null}
            />
          ) : model.live !== null && fatigue ? (
            // The single-Voltra stage (VMCP-05.02) — velocity hero + the real fatigue card.
            // It needs no display unit: the body is velocity/RPE/ROM only, and the page
            // header + rest stage are the mass consumers.
            <SingleFatigueStage model={model as LiveDashboardModel} fatigue={fatigue} />
          ) : model.live !== null ? (
            // Live but NO fatigue model: the two read different sources — `live` is the SSE
            // overlay, the fatigue mapper needs `snapshot.sets.active` — so an SSE frame that
            // leads the snapshot poll opens a brief window where the set is streaming and the
            // card has nothing to show. Fall back to the velocity-only stage for that window
            // rather than blanking the wall mid-set.
            <LiveView model={model as LiveDashboardModel} slot="L" />
          ) : stageIsEmpty(model) ? (
            // Nothing streaming, logged, or resting ⇒ the designed idle stage, not a blank
            // RestView (the barren no-session / pre-first-set view).
            <EmptyLiveView model={model} />
          ) : (
            // No set streaming ⇒ the rest stage: recap of the set just finished + countdown.
            <RestView model={model} displayUnit={displayUnit} />
          )}
        </View>
      </View>
      {/* Subtle wall-corner unit toggle — overlays the stage, out of the reading path. */}
      <UnitToggle unit={displayUnit} onChange={setDisplayUnit} />
    </Surface>
  );
}

/**
 * How far into the current set we are, as a fraction of a set (0 when not mid-set).
 *
 * Needs a rep target to be a fraction of anything; without one the set contributes 0 to
 * the pace bar rather than a guess.
 */
function liveSetProgress(model: DashboardModel): number {
  const { live, session } = model;
  if (!live || session.targetReps === null || session.targetReps === 0) return 0;
  return Math.min(live.repVelocities.length / session.targetReps, 1);
}
