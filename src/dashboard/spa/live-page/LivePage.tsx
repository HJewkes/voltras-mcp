// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import {
  EmptyState,
  SessionRail,
  Surface,
  BluetoothIcon,
  alpha,
  getSemanticColors,
  useOnSurfaceColor,
} from '@titan-design/react-ui';
import { ExerciseHeader, LiveView, VerticalSlotLabel, type VoltraSlot } from './LiveView';
import { RestView } from './RestView';
import { EmptyLiveView } from './EmptyLiveView';
import {
  deriveRailExercises,
  deriveRailMetrics,
  stageIsEmpty,
  type DashboardModel,
  type DualDashboardModel,
  type LiveDashboardModel,
} from './model';
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

export interface LivePageProps {
  /** Which stage to show in the main region. */
  variant?: LivePageVariant;
  /** The dashboard store snapshot, projected by `panels/live-view.ts`. */
  model: DashboardModel;
  /**
   * The per-limb models for the dual (bilateral) stage (VW-71), projected by
   * `mapStoreToDualModel`. Required for `variant === 'live-dual'`; ignored otherwise. A
   * null side is an unbound slot and renders an awaiting state, never a fabricated limb.
   */
  dual?: DualDashboardModel;
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
 *   - `live-dual` renders REAL per-slot telemetry (VW-71), one {@link DualLiveStage} half per
 *     bound Voltra from `mapStoreToDualModel`. An unbound slot shows an honest awaiting side,
 *     never a fabricated or mirrored limb.
 *
 * The rail footer pace read-out is intentionally OMITTED (no store field).
 */
export function LivePage({ variant = 'live', model, dual }: LivePageProps) {
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
        {/* workout title + targets — page-level, always visible, independent of single/dual. */}
        <ExerciseHeader session={model.session} displayUnit={displayUnit} />
        <View style={{ flex: 1 }}>
          {variant === 'live-dual' ? (
            <DualLiveStage dual={dual} displayUnit={displayUnit} />
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

/** side → the vertical slot badge + awaiting-state label. */
const DUAL_SIDE: Record<'left' | 'right', { slot: VoltraSlot; label: string }> = {
  left: { slot: 'L', label: 'Left Voltra' },
  right: { slot: 'R', label: 'Right Voltra' },
};

/**
 * An unbound slot's honest awaiting state (VW-71): the side's vertical badge beside a
 * "bind a Voltra" prompt. NEVER a fabricated limb — this is what the missing side shows so
 * a one-Voltra session reads as "one bound, one waiting", not a mirrored duplicate.
 */
function AwaitingSlotView({ side }: { side: 'left' | 'right' }) {
  const { slot, label } = DUAL_SIDE[side];
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <VerticalSlotLabel slot={slot} />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 18 }}>
        <EmptyState
          icon={BluetoothIcon}
          title={`${label} — not bound`}
          description="Bind a Voltra to this side to see its live velocity, tempo and fatigue."
        />
      </View>
    </View>
  );
}

/**
 * One half of the dual stage (VW-71) for a single Voltra slot: the same live / rest / empty
 * selection the single view makes, on THIS slot's own model — so each limb reflects its own
 * device. A null model is an unbound slot ⇒ {@link AwaitingSlotView}. Non-live sides keep the
 * side's vertical badge so the recap/idle halves still read as left vs right.
 */
function DualSideView({
  model,
  side,
  displayUnit,
}: {
  model: DashboardModel | null;
  side: 'left' | 'right';
  displayUnit: MassUnit;
}) {
  if (model === null) return <AwaitingSlotView side={side} />;
  // Mid-set: the live layer carries its own vertical slot badge via `side`.
  if (model.live !== null) return <LiveView model={model as LiveDashboardModel} side={side} />;
  const { slot } = DUAL_SIDE[side];
  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <VerticalSlotLabel slot={slot} />
      <View style={{ flex: 1 }}>
        {stageIsEmpty(model) ? (
          <EmptyLiveView model={model} />
        ) : (
          <RestView model={model} displayUnit={displayUnit} />
        )}
      </View>
    </View>
  );
}

/**
 * Dual-mode stage — REAL per-limb telemetry (VW-71), one {@link DualSideView} per slot from
 * `mapStoreToDualModel`. Falls back to two awaiting sides when no dual model is supplied.
 *
 * The stage SCROLLS so two full read-outs never clip on a height-restricted wall. Each live
 * layer compresses its height-drivers (shorter hero, tighter gaps — see {@link LiveView}'s
 * `side`/`dual` handling) so a tall wall fits both with little or no scroll.
 */
function DualLiveStage({
  dual,
  displayUnit,
}: {
  dual?: DualDashboardModel;
  displayUnit: MassUnit;
}) {
  const left = dual?.left ?? null;
  const right = dual?.right ?? null;
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={{ flex: 1, minHeight: 340 }}>
        <DualSideView model={left} side="left" displayUnit={displayUnit} />
      </View>
      <View style={{ flex: 1, minHeight: 340 }}>
        <DualSideView model={right} side="right" displayUnit={displayUnit} />
      </View>
    </ScrollView>
  );
}
