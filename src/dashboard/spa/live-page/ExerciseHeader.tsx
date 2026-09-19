// Font mapping: font-heading=Space Grotesk, font-body=Nunito Sans (UI), font-sans=Inter (body)
import { useState } from 'react';
import { View, Text, type LayoutChangeEvent } from 'react-native';
import {
  SetsRepsLoad,
  SetStrip,
  TempoDisplay,
  Tooltip,
  getSemanticColors,
  useOnSurfaceColor,
} from '@titan-design/react-ui';
import {
  type DashboardModel,
  type SetupCard,
  AUTO_ARM_BADGE_TEXT,
  autoArmedBadge,
  autoArmedTitle,
  deriveActiveSetStates,
  derivePrescription,
  stageIsEnded,
} from './model';
import { type MassUnit } from './mass';

const t = getSemanticColors('dark');

/**
 * Raised-card separation, as a HAIRLINE rather than a shadow.
 *
 * titan 0.12.0 deleted `neumorphicShadows`, and the reason matters here: the
 * treatment needs a mid-tone ground (~75-90% L) for its dark half to fall onto.
 * These cards sit near 10% L, so that half was already collapsing and the cards
 * were carrying a one-sided smudge rather than the elevation they asked for.
 *
 * An INSET ring rather than a border, deliberately — a real `borderWidth` would
 * add a pixel to a card whose height is pinned to CONTROL_HEIGHT so it lines up
 * with its neighbour, and would push the inner content on a surface that is
 * already `overflow: 'hidden'`.
 */
const CARD_EDGE = { boxShadow: `inset 0 0 0 1px ${t['hairline-default']}` } as const;

/** Clamped linear interpolation of `v` between `vLo..vHi` as `w` runs `wLo..wHi`. */
function clampLerp(w: number, wLo: number, wHi: number, vLo: number, vHi: number): number {
  if (w <= wLo) return vLo;
  if (w >= wHi) return vHi;
  return vLo + ((w - wLo) / (wHi - wLo)) * (vHi - vLo);
}

// --- Page-level exercise header -----------------------------------------------

/** Below this header width the targets line wraps under the name (at the set-heading ratio). */
const HEADER_WRAP = 480;
/** At/above this header width the targets render at full size. */
const HEADER_WIDE = 760;
/** Targets:name size ratio on the wrapped second line — matches ExerciseHeading (11 / 14). */
const SET_HEADING_RATIO = 11 / 14;
const HEADER_NAME_SIZE = 30;

/** Page-header strip height — the rail's 8px bar, thickened for the wall read. */
const HEADER_STRIP_HEIGHT = 10;
/** Tempo digit size in the header — the rail's compact chip, raised for the wall read. */
const HEADER_TEMPO_FONT = 13;
const SETUP_CARD_ANCHOR_LABEL: Record<SetupCard['anchor'], string> = {
  low: 'Low',
  mid: 'Mid',
  chest: 'Chest',
  high: 'High',
};

/**
 * The expected setup card as one line: `Anchor: Mid · Hole 3 · Cable 36 · Normal`.
 * Only `anchor` is guaranteed — the rest are joined in only when present, so a
 * digest-seeded default (anchor only) reads as a short hint, not a padded row.
 */
function formatSetupCard(card: SetupCard): string {
  const parts = [`Anchor: ${SETUP_CARD_ANCHOR_LABEL[card.anchor]}`];
  if (card.mountHole !== undefined) parts.push(`Hole ${card.mountHole}`);
  if (card.cableLengthSetting !== undefined) parts.push(`Cable ${card.cableLengthSetting}`);
  if (card.mode !== undefined) parts.push(card.mode);
  return parts.join(' · ');
}

/**
 * The compact "AUTO" chip for an auto-armed active set (VW-265) — a hairline-outlined pill
 * matching the header's existing chrome ({@link CARD_EDGE}), with the auto-arm mechanism
 * (guided load vs the lifter's own reps) on hover rather than crowding the header with it.
 */
function AutoArmBadge({ source }: { source: 'guided_load' | 'idle_rep' }) {
  const textColor = useOnSurfaceColor('secondary');
  return (
    <Tooltip label={autoArmedTitle(source)} placement="bottom">
      <View
        testID="auto-arm-badge"
        style={{
          paddingHorizontal: 8,
          paddingVertical: 3,
          borderRadius: 6,
          ...CARD_EDGE,
        }}
      >
        <Text style={{ color: textColor, fontSize: 11, fontWeight: '700', letterSpacing: 1 }}>
          {AUTO_ARM_BADGE_TEXT}
        </Text>
      </View>
    </Tooltip>
  );
}

/**
 * The workout title + targets — the exercise being performed, independent of how many
 * voltras drive it, so it lives at the TOP OF THE PAGE (above the live stage) and stays
 * visible across single/dual. NOT a published component.
 *
 * Two rows, per the north-star lockup: the name left with the `sets × reps @ load`
 * prescription pinned right at wall scale, then the per-set {@link SetStrip} running the
 * remaining width under the name with the prescribed tempo tucked right under the lockup.
 * The prescription shrinks with width and only wraps under the name (at the set-heading
 * size ratio) once too tight to shrink further.
 *
 * The strip is the ACTIVE exercise only — the rail keeps its own per-exercise rows, and
 * both read {@link deriveActiveSetStates} so they cannot disagree. Each element hides
 * independently when its data is absent: no prescription ⇒ no lockup, no sets ⇒ no strip,
 * no prescribed tempo ⇒ no tempo (a coach may genuinely leave it unset).
 */
export function ExerciseHeader({
  model,
  displayUnit = 'lbs',
}: {
  model: DashboardModel;
  /** Client DISPLAY unit for the load readout (VW-63). Store weight stays lbs. */
  displayUnit?: MassUnit;
}) {
  const [w, setW] = useState(0);
  // On-surface primary text from the Surface context — see the note at the heading below.
  const nameColor = useOnSurfaceColor('primary');
  // Secondary, not primary: the lifter's name qualifies the exercise rather
  // than competing with it for the wall read.
  const lifterColor = useOnSurfaceColor('secondary');
  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);
  const { session, connection, live } = model;
  // VW-265: the badge names the CURRENTLY ACTIVE set only — it disappears with the live
  // overlay once the set closes, same as the rest of this mid-set chrome.
  const autoArmSource = live ? autoArmedBadge(live) : null;
  const targets = derivePrescription(session, displayUnit);
  const setStates = deriveActiveSetStates(model);
  const wrap = w > 0 && w < HEADER_WRAP;
  const targetSize = wrap
    ? Math.round(HEADER_NAME_SIZE * SET_HEADING_RATIO) // set-heading ratio on the second line
    : Math.round(clampLerp(w || HEADER_WIDE, HEADER_WRAP, HEADER_WIDE, 22, 28));

  // A KNOWN disconnect (VW-68) — same reading EmptyLiveView uses. Unchanged: the shell owns
  // the disconnected messaging and this header stays hidden rather than duplicating it.
  const disconnected = connection?.connected === false;

  // No open session, but connected (or connection unknown) ⇒ no exercise to title (VMCP-03.08).
  // Keep the region rather than removing it — the wall's layout should not jump when a session
  // opens — but show the same idle copy EmptyLiveView's stage uses rather than the `Exercise N`
  // ordinal, which exists to name a genuinely open session and would misdescribe an idle wall.
  // A session that just ENDED (VW-261) gets its own heading rather than reusing the idle
  // "Waiting for a set" copy, which would misdescribe a wall that just finished a workout.
  const headingText = stageIsEnded(model)
    ? 'Session complete'
    : session.hasSession
      ? session.exerciseName
      : 'Waiting for a set';

  if (disconnected) return null;

  return (
    <View
      testID="exercise-header"
      onLayout={onLayout}
      className="border-border"
      style={{
        paddingHorizontal: 24,
        paddingTop: 20,
        paddingBottom: 16,
        borderBottomWidth: 1,
        gap: 10,
      }}
    >
      {/* The session-block title (VW-43) — only when the plan chain resolves one; no
          placeholder when it doesn't, so an ad-hoc/freestyle session shows no caption
          rather than an invented or generic label. */}
      {session.title !== null && (
        <Text
          testID="session-title"
          style={{
            color: lifterColor,
            fontSize: Math.round(HEADER_NAME_SIZE * SET_HEADING_RATIO),
            fontFamily: '"Space Grotesk", sans-serif',
            fontWeight: '600',
          }}
        >
          {session.title}
        </Text>
      )}
      <View
        style={{
          flexDirection: wrap ? 'column' : 'row',
          alignItems: wrap ? 'flex-start' : 'baseline',
          justifyContent: 'space-between',
          gap: wrap ? 4 : 22,
        }}
      >
        <Text
          testID="exercise-header-name"
          style={{
            // On-surface primary text from the Surface context (LivePage's Surface root), not the
            // `text-text-primary` className — the className→CSS-var path renders black on the
            // standalone wall SPA (the var only exists inside titan's themed provider). The hook
            // returns literal hex, so the stage heading stays legible.
            color: nameColor,
            fontSize: HEADER_NAME_SIZE,
            fontFamily: '"Space Grotesk", sans-serif',
            fontWeight: '700',
          }}
        >
          {headingText}
        </Text>
        {/* VW-265: only while the active set is streaming AND the server opened it itself. */}
        {autoArmSource && <AutoArmBadge source={autoArmSource} />}
        {/* VW-169: whose set this is, shown ONLY for a guest working in — the wall is the
            owner's by default, and a name on every set would be noise that stops being read
            by the time it matters. */}
        {session.lifter !== null && (
          <Text
            style={{
              color: lifterColor,
              fontSize: Math.round(HEADER_NAME_SIZE * SET_HEADING_RATIO),
              fontFamily: '"Space Grotesk", sans-serif',
              fontWeight: '600',
            }}
          >
            {session.lifter}
          </Text>
        )}
        {/* targets: pinned right when inline, tucked under the name (smaller) when wrapped. */}
        {targets && (
          <SetsRepsLoad
            sets={targets.sets}
            reps={targets.reps}
            load={targets.load}
            unit={targets.unit}
            fontSize={targetSize}
          />
        )}
      </View>
      {/* The expected setup card at exercise start (VW-275) — anchor/mount/cable-length/mode,
          shown as a hint to check the rig before the first rep, never as a measurement of the
          set in progress. Hidden entirely with no session or no card resolved, same as the
          plan-title row above. */}
      {session.hasSession && session.expectedSetupCard != null && (
        <Text
          testID="expected-setup-card"
          style={{
            color: lifterColor,
            fontSize: Math.round(HEADER_NAME_SIZE * SET_HEADING_RATIO),
            fontFamily: '"Space Grotesk", sans-serif',
            fontWeight: '600',
          }}
        >
          {formatSetupCard(session.expectedSetupCard)}
        </Text>
      )}
      {/* Strip + tempo. The whole row goes when it would carry neither, so the header
          collapses back to its one-line form rather than leaving a hairline of padding. */}
      {(setStates.length > 0 || session.tempo) && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <View style={{ flex: 1 }}>
            {setStates.length > 0 && <SetStrip sets={setStates} height={HEADER_STRIP_HEIGHT} />}
          </View>
          {/* The rail row's compact tempo chip verbatim (label + info off), sized up for
              the wall — the prescribed tempo, NOT the live phase-fill on the stage. */}
          {session.tempo && (
            <TempoDisplay
              tempo={session.tempo}
              size="sm"
              fontSize={HEADER_TEMPO_FONT}
              showLabel={false}
              showInfo={false}
            />
          )}
        </View>
      )}
    </View>
  );
}
