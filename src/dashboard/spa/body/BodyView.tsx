/**
 * The `#/body` wall page's pure render (VW-338, plan D1 / wireframe W1).
 *
 * Split from `BodyPage` (the fetch wrapper) exactly as `GoalsView` is, so this
 * takes the three fetched payloads as props and nothing else — no store read, no
 * fetch, no clock. That is what lets the render test hand it `/api/muscle-week`,
 * `/api/muscle-strength` and `/api/muscle-plan` fixtures directly.
 *
 * ── Layout (W1) ──────────────────────────────────────────────────────────
 * Three columns — NEXT UP + RECENT PRs on the left, the front and back figures
 * in the middle, THIS WEEK + the status legend on the right — over a full-width
 * `MuscleStrip`. The figures are `size="wall"` (480x960 each), which is the
 * whole point of the page: a three-metre read of which muscles got trained.
 *
 * This page renders NO live telemetry. A set running while it is open shows as
 * the Live rail item's cue and nothing else (plan §3, NAV-D02) — the wall's
 * live surface is the live page, and two of them would compete.
 *
 * LAYOUT via `style`, never `className` — titan components are react-native-web
 * Views that silently drop Tailwind layout utilities. Colour comes from
 * `<Surface level>` / titan's own `getHeatmapColor` / semantic tokens, never a
 * raw hex.
 */
import React from 'react';
import {
  Caption,
  EmptyState,
  MetricTiles,
  MuscleStrip,
  PrBadge,
  Surface,
  Typography,
  useSurfaceMode,
  type MetricTileData,
} from '@titan-design/react-ui';
import {
  BodyMap,
  getHeatmapColor,
  VOLUME_STATUS_LABELS,
  type VolumeStatus,
} from '@titan-design/react-ui/bodymap';

import { PanelCard, PANEL_GAP } from '../planner/PanelCard.js';
import { SPACE } from '../planner/design.js';
import { PAGE_PADDING } from '../planner/PlanBuilderPage.js';
import { useIsNarrowViewport } from '../use-viewport.js';
import {
  bodyMapData,
  muscleStripData,
  nextUpRows,
  prRows,
  prValueText,
  weekSummary,
  type BodyPageData,
  type NextUpRow,
  type PrRow,
} from './body-model.js';

/** The rails either side of the figures. Wide enough for an exercise name and its targets. */
const RAIL_WIDTH = 360;

/**
 * How far the figure column is shrunk so the whole page is one wall screen.
 *
 * `size="wall"` draws a 480x960 figure, and the block around it (view labels,
 * legend) measures ~1070px tall. The 1080p wall has ~940px of content height
 * below the top bar once the page gutter and the muscle strip are taken out, so
 * at 1:1 the figures' legs and the strip both fall off the bottom.
 *
 * `zoom`, not `transform: scale` — zoom reflows, so the strip moves up with the
 * figures instead of sitting under a 1070px hole. Both are still ~350x700, well
 * past a three-metre read.
 */
const FIGURE_ZOOM = 0.66;

/**
 * `BodyMap`'s own width. It draws a 480px-wide figure but sets no width on its
 * wrapper, so its muscle legend — a `flex-row flex-wrap` of chips, and the
 * page's only tappable surface for the `aria-hidden` SVG — has nothing to wrap
 * against and runs off the card. Pinning the figure's own width is what makes
 * it wrap under the figure it belongs to.
 */
const FIGURE_WIDTH = 480;

/** A rail row's two stacked lines. RNW `Text` is inline, so the stack is a flex column. */
const RAIL_ROW_TEXT: React.CSSProperties = {
  flex: '1 1 0',
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
};

/** The five statuses the figure can paint, in the order the scale runs. */
const LEGEND_STATUSES: readonly VolumeStatus[] = [
  'behind',
  'ontrack',
  'target',
  'approaching',
  'over',
];

export function BodyView(props: { data: BodyPageData }): React.JSX.Element {
  const { data } = props;
  const narrow = useIsNarrowViewport();
  const figures = bodyMapData(data.week);

  return (
    <Surface level="base" style={{ minHeight: '100%', padding: PAGE_PADDING, gap: PANEL_GAP }}>
      <div
        style={{
          display: 'flex',
          flexDirection: narrow ? 'column' : 'row',
          gap: PANEL_GAP,
          alignItems: 'flex-start',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: PANEL_GAP,
            width: narrow ? '100%' : RAIL_WIDTH,
            flexShrink: 0,
          }}
        >
          <NextUpPanel rows={nextUpRows(data.plan)} />
          <RecentPrsPanel rows={prRows(data.strength)} />
        </div>
        <FigurePanel data={figures} weekStart={data.week.weekStart} />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: PANEL_GAP,
            width: narrow ? '100%' : RAIL_WIDTH,
            flexShrink: 0,
          }}
        >
          <ThisWeekPanel data={data} />
          <LegendPanel />
        </div>
      </div>
      <PanelCard title="Weekly sets by muscle">
        <MuscleStrip data={muscleStripData(data.week)} />
      </PanelCard>
    </Surface>
  );
}

/**
 * The two figures, front and back, side by side. Neither takes `onViewChange`:
 * both faces are on screen at once, so a toggle would switch a view that is
 * already there. `BodyMap` renders the toggle disabled in that case, which is
 * what labels each figure.
 */
function FigurePanel(props: {
  data: ReturnType<typeof bodyMapData>;
  weekStart: string;
}): React.JSX.Element {
  return (
    <div style={{ flex: '1 1 0', minWidth: 0 }}>
      <PanelCard title={`Week of ${props.weekStart.slice(0, 10)}`}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            justifyContent: 'center',
            gap: SPACE.xl,
            zoom: FIGURE_ZOOM,
          }}
        >
          <BodyMap data={props.data} view="front" size="wall" style={{ width: FIGURE_WIDTH }} />
          <BodyMap data={props.data} view="back" size="wall" style={{ width: FIGURE_WIDTH }} />
        </div>
      </PanelCard>
    </div>
  );
}

/** Planned lifts the active training week still owes. Empty with no program (a 404 plan). */
function NextUpPanel(props: { rows: NextUpRow[] }): React.JSX.Element {
  if (props.rows.length === 0) {
    return (
      <PanelCard title="Next up">
        <EmptyState title="No planned week" description="Start a program to see what is due." />
      </PanelCard>
    );
  }
  return (
    <PanelCard title="Next up">
      <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.xs }}>
        {props.rows.map((row) => (
          <div
            key={row.exerciseId}
            style={{ display: 'flex', alignItems: 'baseline', gap: SPACE.xs }}
          >
            <div style={RAIL_ROW_TEXT}>
              <Typography variant="body1">{row.exerciseName}</Typography>
              <Caption color="tertiary">{row.workoutName}</Caption>
            </div>
            <Typography variant="body1">{`${row.sets} sets`}</Typography>
          </div>
        ))}
      </div>
    </PanelCard>
  );
}

/** Every PR the strength read model flagged, best e1RM first. */
function RecentPrsPanel(props: { rows: PrRow[] }): React.JSX.Element {
  if (props.rows.length === 0) {
    return (
      <PanelCard title="Recent PRs">
        <EmptyState title="No PRs yet" description="A new best e1RM shows up here." />
      </PanelCard>
    );
  }
  return (
    <PanelCard title="Recent PRs" titleRight={<PrBadge type="weight" compact />}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.xs }}>
        {props.rows.map((row) => (
          <div key={row.key} style={{ display: 'flex', alignItems: 'baseline', gap: SPACE.xs }}>
            <div style={RAIL_ROW_TEXT}>
              <Typography variant="body1">
                {row.side === null ? row.exerciseName : `${row.exerciseName} · ${row.side}`}
              </Typography>
              <Caption color="tertiary">{row.muscleLabel}</Caption>
            </div>
            <Typography variant="body1">{prValueText(row)}</Typography>
          </div>
        ))}
      </div>
    </PanelCard>
  );
}

/** The glance tiles, plus the honest label on where the landmarks come from. */
function ThisWeekPanel(props: { data: BodyPageData }): React.JSX.Element {
  const summary = weekSummary(props.data.week);
  const tiles: MetricTileData[] = [
    { label: 'Sets', value: `${summary.totalSets}` },
    { label: 'Muscles', value: `${summary.trainedMuscles}` },
    { label: 'Productive', value: `${summary.productive}` },
  ];
  return (
    <PanelCard title="This week">
      <MetricTiles metrics={tiles} gap={2} />
      <div style={{ marginTop: SPACE.sm }}>
        <MetricTiles
          gap={2}
          metrics={[
            { label: 'Below MEV', value: `${summary.under}` },
            { label: 'Over MRV', value: `${summary.over}` },
          ]}
        />
      </div>
      {/* The landmarks are population defaults, not this athlete's — saying so is
          the difference between a reference and a prescription (plan §4 risks). */}
      <div style={{ marginTop: SPACE.sm }}>
        <Caption color="tertiary">{`Landmarks: ${props.data.week.landmarkBasis}`}</Caption>
      </div>
    </PanelCard>
  );
}

/**
 * The status scale, in the figure's own colours. `getHeatmapColor` is titan's
 * single status-to-colour map, so a legend swatch and the muscle it explains
 * cannot drift apart; `untrained` is absent because the figure paints nothing
 * for it (it keeps the outline fill).
 */
function LegendPanel(): React.JSX.Element {
  const mode = useSurfaceMode();
  return (
    <PanelCard title="Legend">
      <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.xs }}>
        {LEGEND_STATUSES.map((status) => (
          <div key={status} style={{ display: 'flex', alignItems: 'center', gap: SPACE.xs }}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                backgroundColor: getHeatmapColor(status, mode),
              }}
            />
            <Caption>{VOLUME_STATUS_LABELS[status]}</Caption>
          </div>
        ))}
      </div>
    </PanelCard>
  );
}
