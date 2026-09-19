import { useState, type ReactElement } from 'react';
import { View, Text, type LayoutChangeEvent } from 'react-native';
import {
  TempoDisplay,
  ActivityIcon,
  AlertTriangleIcon,
  CircleSlashIcon,
  Tooltip,
  getSemanticColors,
  alpha,
  type IconProps,
} from '@titan-design/react-ui';
import { type DashboardModel } from './model';

// Verdict STATUS tones (success/warning/error) for the alert cue — semantic status colours,
// not on-surface text roles, so they come from the token map rather than `useOnSurfaceColor`.
// The stage sits on the LiveAuraFrame (its own verdict-flooded plane), not a charcoal Surface;
// the text below resolves via the on-surface context seeded by the LivePage Surface root.
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
/** One row height for the tempo + alert cards, so they line up regardless of tempo font size. */
const CONTROL_HEIGHT = 34;
/** Gap between the tempo card and the alert — also subtracted from the alert's budget. */
const CONTROLS_GAP = 16;
/** The tempo card ground — mirrors TempoDisplay's own charcoal so a shorter inner pill reads seamless. */
const TEMPO_GROUND = '#1C1C1C';

/** Clamped linear interpolation of `v` between `vLo..vHi` as `w` runs `wLo..wHi`. */
function clampLerp(w: number, wLo: number, wHi: number, vLo: number, vHi: number): number {
  if (w <= wLo) return vLo;
  if (w >= wHi) return vHi;
  return vLo + ((w - wLo) / (wHi - wLo)) * (vHi - vLo);
}

// --- Alert cue ----------------------------------------------------------------

type Verdict = 'productive' | 'threshold' | 'stop';
const STATUS_COLOR: Record<Verdict, string> = {
  productive: t['status-success'],
  threshold: t['status-warning'],
  stop: t['status-error'],
};
const VERDICT_LABEL: Record<Verdict, string> = {
  productive: 'Productive',
  threshold: 'Threshold',
  stop: 'Stop',
};
// A CONTEXTUAL glyph keyed on proximity to the velocity-loss threshold (replaces the flat
// colour dot): a healthy pulse well under, a warning triangle at the threshold band, a
// slashed circle once past it.
const STATUS_ICON: Record<Verdict, (props: IconProps) => ReactElement> = {
  productive: ActivityIcon,
  threshold: AlertTriangleIcon,
  stop: CircleSlashIcon,
};

/** How much of the alert survives at the current width. */
export type AlertMode = 'full' | 'compact' | 'icon';

/** The tinted alert surface (border + wash + raised shadow) shared by the card and the icon pill. */
function alertSurface(tone: string) {
  return {
    borderWidth: 1,
    borderColor: alpha(tone, 0.45),
    backgroundColor: alpha(tone, 0.14),
    // No CARD_EDGE here: this surface already carries its own TINTED border, and
    // the tint is the point — it names the verdict. A neutral hairline on top
    // would only mute it.
  };
}

/**
 * The single status element — a tinted alert card carrying the exertion message. It sheds
 * detail as space tightens: `full` shows the contextual icon + verdict + inline message
 * (capped at `availWidth` so it ellipsises + keeps a hover tip rather than running off-page);
 * `compact` drops the message to the tip; `icon` collapses to just the contextual glyph,
 * verdict + message on hover.
 */
function AlertCue({
  status,
  message,
  mode,
  availWidth,
}: {
  status: Verdict;
  message: string;
  mode: AlertMode;
  /** Pixels the alert may occupy (row width − tempo − gap); caps the card so the message clips. */
  availWidth?: number;
}) {
  const tone = STATUS_COLOR[status];
  const Icon = STATUS_ICON[status];
  const meaningful = status === 'threshold' || status === 'stop';

  // Tightest: icon-only pill. Verdict + message live in the hover tip.
  if (mode === 'icon') {
    const pill = (
      <View
        style={{
          width: CONTROL_HEIGHT,
          height: CONTROL_HEIGHT,
          borderRadius: 9,
          alignItems: 'center',
          justifyContent: 'center',
          ...alertSurface(tone),
        }}
      >
        <Icon size={17} color={tone} />
      </View>
    );
    return meaningful ? (
      <Tooltip label={`${VERDICT_LABEL[status]} · ${message}`} placement="bottom">
        {pill}
      </Tooltip>
    ) : (
      pill
    );
  }

  const card = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        height: CONTROL_HEIGHT,
        // Concrete px cap (not %) so the single-line message ellipsises through the wrapper chain.
        maxWidth: availWidth,
        borderRadius: 10,
        paddingHorizontal: 12,
        ...alertSurface(tone),
      }}
    >
      <Icon size={15} color={tone} />
      <Text style={{ color: tone, fontSize: 13, fontWeight: '700', flexShrink: 0 }}>
        {VERDICT_LABEL[status]}
      </Text>
      {mode === 'full' && meaningful && (
        // Bounded + single-line: ellipsises instead of pushing off the page (full text on hover).
        <Text
          numberOfLines={1}
          style={{ color: tone, fontSize: 13, fontWeight: '600', flexShrink: 1, minWidth: 0 }}
        >
          · {message}
        </Text>
      )}
    </View>
  );
  // Keep the full message a hover away whenever it isn't fully spelled out (compact) or may be
  // clipped (full → ellipsis).
  return meaningful ? (
    <Tooltip label={message} placement="bottom">
      {card}
    </Tooltip>
  ) : (
    card
  );
}

// --- Live tempo phase mapping -------------------------------------------------

/** Map the model's movement phase onto TempoDisplay's live-fill phase key. */
function mapLivePhase(
  phase: NonNullable<DashboardModel['live']>['phase'],
): 'eccentric' | 'pauseBottom' | 'concentric' | null {
  switch (phase) {
    case 'concentric':
      return 'concentric';
    case 'eccentric':
      return 'eccentric';
    case 'hold':
      return 'pauseBottom';
    default:
      return null;
  }
}

// --- Shared controls row ------------------------------------------------------

/** Below this content width the alert drops its inline message to a hover tip. */
const ALERT_COMPACT = 620;
/** Below this content width the alert collapses to just its contextual icon. */
const ALERT_ICON = 430;
/** Tempo digit size at rest — matched to sit within {@link CONTROL_HEIGHT}. */
const TEMPO_BASE_FONT = 18;
/** Content width at which the tempo has shrunk as far as it goes (near the panel min). */
const TEMPO_SHRINK_FLOOR = 300;

/**
 * The tempo card + exertion alert that sit above a velocity hero, with all the
 * shed-detail sizing that makes them survive a narrow panel.
 *
 * The exertion verdict describes the athlete, not a limb — `LiveFatigueModel` says
 * there is exactly ONE of these cards even when two devices are live — so
 * {@link DivergingLiveStage} renders this row once, shared, rather than repeating
 * the sizing logic per side.
 *
 * `containerWidth` is passed IN rather than measured here on purpose: the caller
 * already measures its content box, and re-measuring inside the row would shift
 * the breakpoints by the caller's padding — a silent visual change to the shipped
 * layout. The caller owns the reference width; this owns what to do with it.
 */
export function LiveControlsRow({
  tempo,
  verdict,
  message,
  containerWidth,
  livePhase,
  phaseElapsedMs,
}: {
  tempo: DashboardModel['session']['tempo'];
  verdict: Verdict;
  message: string;
  containerWidth: number;
  /** The model's raw movement phase — mapped to TempoDisplay's key HERE, so no caller
   *  has to know the mapping (and none can quietly pass `null` and lose the live fill). */
  livePhase: NonNullable<DashboardModel['live']>['phase'];
  phaseElapsedMs: number;
}) {
  const activePhase = mapLivePhase(livePhase);
  const [rowW, setRowW] = useState(0);
  const [tempoW, setTempoW] = useState(0);

  // The alert sheds detail first (message → verdict → icon); the tempo holds its full size
  // until the alert can't shrink any further, then it takes over shrinking.
  const alertMode: AlertMode =
    containerWidth === 0 || containerWidth >= ALERT_COMPACT
      ? 'full'
      : containerWidth >= ALERT_ICON
        ? 'compact'
        : 'icon';
  const tempoFont =
    containerWidth === 0 || containerWidth >= ALERT_ICON
      ? TEMPO_BASE_FONT
      : Math.round(clampLerp(containerWidth, TEMPO_SHRINK_FLOOR, ALERT_ICON, 14, TEMPO_BASE_FONT));

  // Tempo is optional: a set may have no prescribed tempo — then the card is hidden
  // entirely and the alert takes the whole row.
  const hasTempo = tempo != null;
  // Width the alert may take — measured off the ROW (inside the panel padding) so a long
  // message ellipsises at the side margin rather than running to the panel edge.
  const alertAvail =
    rowW > 0
      ? hasTempo
        ? tempoW > 0
          ? Math.max(0, rowW - tempoW - CONTROLS_GAP)
          : undefined
        : rowW
      : undefined;

  return (
    <View
      onLayout={(e: LayoutChangeEvent) => setRowW(e.nativeEvent.layout.width)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: CONTROLS_GAP,
        justifyContent: hasTempo ? 'space-between' : 'flex-end',
      }}
    >
      {/* tempo card — locked to the alert's height; the inner TempoDisplay shrinks its font
          but stays centred on the shared charcoal ground so it reads seamless. */}
      {tempo != null && (
        <View
          onLayout={(e: LayoutChangeEvent) => setTempoW(e.nativeEvent.layout.width)}
          style={{
            height: CONTROL_HEIGHT,
            justifyContent: 'center',
            alignItems: 'flex-start',
            backgroundColor: TEMPO_GROUND,
            borderRadius: 9,
            overflow: 'hidden',
            ...CARD_EDGE,
          }}
        >
          <TempoDisplay
            tempo={tempo}
            fontSize={tempoFont}
            live={activePhase ? { activePhase, phaseElapsedMs } : undefined}
            showLabel={false}
            showInfo={false}
          />
        </View>
      )}
      <AlertCue status={verdict} message={message} mode={alertMode} availWidth={alertAvail} />
    </View>
  );
}
