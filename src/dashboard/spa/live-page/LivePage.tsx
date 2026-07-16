// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { ScrollView, View } from 'react-native';
import { SessionRail } from '@titan-design/react-ui';
import { ExerciseHeader, LiveView } from './LiveView';
import {
  deriveDualModel,
  deriveRailExercises,
  type DashboardModel,
  type LiveDashboardModel,
} from './model';

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
 * PORTED from titan's `Lab/North Star` specimen, now store-fed. Two deliberate reductions
 * against the lab original, both because the store cannot honestly supply the data:
 *   - The REST stage is NOT ported. Its countdown ring needs a rest TARGET, and nothing
 *     produces one (VW-51) — the lab hardcoded 120s. The dashboard's existing
 *     `RestTimerPanel` hit the same wall and shows count-up elapsed instead. Porting the
 *     ring would mean shipping an invented duration to a wall screen.
 *   - `live-dual` is a design PREVIEW on fixture data, not this session's telemetry — the
 *     live-signal hub carries no slot identity yet (VW-48), so a real bilateral split is
 *     not derivable. It is labelled as such on screen.
 *
 * The rail footer pace read-out is intentionally OMITTED (no store field).
 */
export function LivePage({ variant = 'live', model }: LivePageProps) {
  const exercises = deriveRailExercises(model);
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
      />
      {/* Rail header metrics (Volume/Load/Fatigue) are OMITTED: they need a session-level
          rollup that does not exist yet (VW-52). The lab hardcoded 76% / 7.3k / MOD. */}

      {/* Panel floors at ~phone width so the live view stops collapsing; rail-aware
          breakpoints below this are a later pass. */}
      <View style={{ flex: 1, minWidth: PANEL_MIN_WIDTH }}>
        {/* workout title + targets — page-level, always visible, independent of single/dual. */}
        <ExerciseHeader session={model.session} />
        <View style={{ flex: 1 }}>
          {variant === 'live-dual' ? (
            <DualLiveStage />
          ) : model.live !== null ? (
            // `slot` names the active voltra — the shell has two connected, so the live view
            // flags which one it is reading from (the multi-device single-view case).
            <LiveView model={model as LiveDashboardModel} slot="L" />
          ) : null}
        </View>
      </View>
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
