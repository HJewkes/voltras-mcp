// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { SessionRail, alpha, getSemanticColors } from '@titan-design/react-ui';
import { ExerciseHeader, LiveView } from './LiveView';
import { RestView } from './RestView';
import { EmptyLiveView } from './EmptyLiveView';
import {
  deriveDualModel,
  deriveRailExercises,
  deriveRailMetrics,
  stageIsEmpty,
  type DashboardModel,
  type LiveDashboardModel,
} from './model';
import { type MassUnit } from './mass';

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
        borderColor: t['border-default'],
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
                color: active ? t['text-primary'] : t['text-tertiary'],
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

export interface LivePageProps {
  /** Which stage to show in the main region. */
  variant?: LivePageVariant;
  /** The dashboard store snapshot, projected by `panels/live-view.ts`. */
  model: DashboardModel;
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
 *   - `live-dual` is a design PREVIEW on fixture data, not this session's telemetry — the
 *     live-signal hub carries no slot identity yet (VW-48), so a real bilateral split is
 *     not derivable. It is labelled as such on screen.
 *
 * The rail footer pace read-out is intentionally OMITTED (no store field).
 */
export function LivePage({ variant = 'live', model }: LivePageProps) {
  const [displayUnit, setDisplayUnit] = useDisplayUnit();
  const exercises = deriveRailExercises(model, displayUnit);
  const metrics = deriveRailMetrics(model, displayUnit);
  const completedSets = model.session.completedSets.length;
  const isLive = model.live !== null;

  return (
    // Layout via `style`, colour via className — see the PORTING RULE above.
    <View className="bg-surface-base" style={{ flex: 1, flexDirection: 'row' }}>
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
        {/* workout title + targets — page-level, always visible, independent of single/dual. */}
        <ExerciseHeader session={model.session} displayUnit={displayUnit} />
        <View style={{ flex: 1 }}>
          {variant === 'live-dual' ? (
            <DualLiveStage />
          ) : model.live !== null ? (
            // `slot` names the active voltra — the shell has two connected, so the live view
            // flags which one it is reading from (the multi-device single-view case). The live
            // stage body carries no weight/force readout (velocity/tempo only), so it needs no
            // display unit — the page header + rest stage are the mass consumers.
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
    </View>
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

/**
 * Dual-mode stage — a design PREVIEW on FIXTURE data (VW-48), not live telemetry.
 *
 * The stage SCROLLS so two full live read-outs never clip on a height-restricted wall.
 * Each layer compresses its height-drivers (shorter hero, tighter gaps — see
 * {@link LiveView}'s `side`/`dual` handling) so a tall wall fits both with little or no
 * scroll.
 */
function DualLiveStage() {
  const { left, right } = deriveDualModel();
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ flex: 1, minHeight: 340 }}>
        <LiveView model={left as LiveDashboardModel} side="left" />
      </View>
      <View style={{ flex: 1, minHeight: 340 }}>
        <LiveView model={right as LiveDashboardModel} side="right" />
      </View>
    </ScrollView>
  );
}
