/**
 * The `#/goals` wall page's pure render (VW-355, plan G8').
 *
 * Split from `GoalsPage` (the fetch wrapper) so this component takes the two
 * fetched payloads as props and nothing else — no store read, no fetch, no
 * clock — which is what lets the render test hand it `/api/goal-progress`
 * fixtures directly (plan G8' done_when).
 *
 * ── Layout ───────────────────────────────────────────────────────────────
 * Priority header + `GoalTrajectoryChart` + milestone tiles, then a grid of
 * `GoalLiftCard`, then a grid of `GoalMuscleCard`, then a whole-body panel
 * with the priority rail and the bodyweight tile. Sections come from plan
 * G8'/§4, not invented here.
 *
 * The two grids replaced full-width rows whose label and data sat at opposite
 * edges of a 1920px viewport (VW-386, human 2026-09-14). Each card carries its
 * own `Card` plane, so the grid itself adds only geometry.
 *
 * LAYOUT via `style`, never `className` — same rule as the planner pages;
 * titan components are react-native-web Views that silently drop Tailwind
 * layout utilities. Colour comes from `<Surface level>` / `useOnSurfaceColor`
 * / semantic tokens only, never a raw hex.
 *
 * Phone (VW-356): below `NARROW_BREAKPOINT_PX` the two grids collapse each
 * card to a full-width row (`useIsNarrowViewport`, same hook the planner and
 * `#/body` pages use) and the trajectory chart drops to its own `phone`
 * density width so the card it sits in still fits inside the viewport —
 * `PanelCard`'s `px-5` plus the page gutter is 80px of fixed chrome the chart
 * has to leave room for.
 */
import React from 'react';
import {
  EmptyState,
  GoalLiftCard,
  GoalTrajectoryChart,
  MesoStatusCard,
  MetricTiles,
  Pill,
  PrBadge,
  Surface,
  type MetricTileData,
} from '@titan-design/react-ui';
import { GoalMuscleCard } from '@titan-design/react-ui/bodymap';

import type { StoredPriorityLevel } from '../../../store/types.js';
import { PanelCard, PANEL_GAP } from '../planner/PanelCard.js';
import { SPACE } from '../planner/design.js';
import { PAGE_PADDING } from '../planner/PlanBuilderPage.js';
import { useIsNarrowViewport } from '../use-viewport.js';
import {
  bodyweightTarget,
  cardActuals,
  cardMilestone,
  chartWeeks,
  dateOnly,
  directionOf,
  hasPR,
  liftRows,
  mesoSubtitle,
  muscleCardRows,
  priorityLabel,
  primaryTarget,
  sessionsTarget,
  statusBadgeVariant,
  statusLabel,
  targetLabel,
  titanStatus,
  type GoalMuscleCardRow,
  type GoalTargetRow,
  type GoalsPageData,
} from './goals-model.js';

const CHART_WIDTH = 1200;
/**
 * The chart's own `phone` density kicks in below its 720px `WALL_BREAKPOINT`
 * regardless of the width passed — this value is about fitting the 390px
 * viewport, not the density switch. On that frame the fixed chrome outside
 * this component is titan's 60px `SideNav` rail (plus its 1px border) and,
 * inside it, `PAGE_PADDING` (20px) and `PanelCard`'s own `px-5` (20px) each
 * side: 141px total, leaving 249px. 240 keeps a few px of slack.
 */
const CHART_WIDTH_NARROW = 240;
const CHART_HEIGHT = 340;

export function GoalsView(props: { data: GoalsPageData }): React.JSX.Element {
  const { data } = props;
  const narrow = useIsNarrowViewport();
  if (data.priorities.length === 0) {
    return (
      <Surface level="base" style={{ minHeight: '100%', padding: PAGE_PADDING }}>
        <EmptyState
          title="No priorities declared"
          description="Declare a priority with goal.declare_priorities to see it here."
        />
      </Surface>
    );
  }

  const primary = primaryTarget(data);

  return (
    <Surface level="base" style={{ minHeight: '100%', padding: PAGE_PADDING, gap: PANEL_GAP }}>
      {primary !== null && <PrimaryGoalCard row={primary} narrow={narrow} />}
      <PerLiftGrid rows={liftRows(data)} narrow={narrow} />
      <MuscleGrid rows={muscleCardRows(data)} narrow={narrow} />
      <WholeBodyPanel data={data} />
    </Surface>
  );
}

/** Header + `GoalTrajectoryChart` + milestone tile for the lead priority (plan §4, wall). */
function PrimaryGoalCard(props: { row: GoalTargetRow; narrow: boolean }): React.JSX.Element {
  const { priority, view } = props.row;
  return (
    <PanelCard
      title={priorityLabel(priority)}
      titleRight={view.actuals.some((a) => a.isPR) ? <PrBadge type="weight" compact /> : undefined}
    >
      <MesoStatusCard
        mesoName={priorityLabel(priority)}
        mesoSubtitle={`${mesoSubtitle(view)} · ${priority.level}`}
        basis={view.statusBasis}
        statusBadge={{ label: statusLabel(view.status), variant: statusBadgeVariant(view.status) }}
        metrics={[
          { label: 'Committed', value: round1(view.committed) },
          { label: 'Stretch', value: round1(view.stretch) },
        ]}
        gauges={[]}
        nextTarget={{ icon: '→', text: view.nextMilestone.label }}
      />
      <div style={{ marginTop: SPACE.md }}>
        <GoalTrajectoryChart
          expected={view.expected}
          committed={view.committed}
          stretch={view.stretch}
          actuals={view.actuals.map((a) => ({
            ts: dateOnly(a.ts),
            ...(a.weekIndex === undefined ? {} : { weekIndex: a.weekIndex }),
            value: a.value,
            isPR: a.isPR,
            matched: a.matched,
          }))}
          weeks={chartWeeks(view)}
          // VW-385 port removes this once titan >= 0.18.0 carries the statuses.
          status={titanStatus(view.status)}
          direction={directionOf(view)}
          width={props.narrow ? CHART_WIDTH_NARROW : CHART_WIDTH}
          height={CHART_HEIGHT}
          metricLabel={priorityLabel(priority)}
        />
      </div>
    </PanelCard>
  );
}

/**
 * Four columns at 1920 and never narrower than the width below which the cards
 * collapse their own status pill. `flex-*` classNames are not an option here:
 * these grids sit inside react-native-web Views, which drop Tailwind layout
 * utilities, so the geometry is inline `style` (same rule as the planner pages).
 */
const CARD_GRID: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'wrap',
  gap: SPACE.md,
  alignItems: 'stretch',
};

/**
 * Four 25% columns and three gaps come to exactly 100% of the row. `flexGrow`
 * stays 0 so a short last row keeps the column width instead of a lone card
 * stretching to the full 1780px the wall gives it.
 *
 * Narrow (VW-356): one column, full width, and `minWidth` drops rather than
 * shrinking — the wall's 320px floor is wider than a 390px viewport minus its
 * own page and card gutters, so keeping it would push the card off the edge.
 */
function cardCellStyle(narrow: boolean): React.CSSProperties {
  if (narrow) return { flexGrow: 0, flexBasis: '100%', minWidth: 0 };
  return { flexGrow: 0, flexBasis: `calc(25% - ${(SPACE.md * 3) / 4}px)`, minWidth: 320 };
}

/** One card per exercise-tracked target (`top_load_at_reps`). */
function PerLiftGrid(props: { rows: GoalTargetRow[]; narrow: boolean }): React.JSX.Element | null {
  if (props.rows.length === 0) return null;
  const cell = cardCellStyle(props.narrow);
  return (
    <PanelCard title="Per-lift">
      <div style={CARD_GRID}>
        {props.rows.map((row) => (
          <div key={row.view.target.id} style={cell}>
            <GoalLiftCard
              name={targetLabel(row)}
              // VW-385 port removes this once titan >= 0.18.0 carries the statuses.
              status={titanStatus(row.view.status)}
              milestone={cardMilestone(row.view)}
              committed={row.view.committed}
              stretch={row.view.stretch}
              actuals={cardActuals(row.view)}
              isPR={hasPR(row.view)}
            />
          </div>
        ))}
      </div>
    </PanelCard>
  );
}

/** One card per `muscle`-kind priority, from its rollup and its contributing lifts. */
function MuscleGrid(props: {
  rows: GoalMuscleCardRow[];
  narrow: boolean;
}): React.JSX.Element | null {
  if (props.rows.length === 0) return null;
  const cell = cardCellStyle(props.narrow);
  return (
    <PanelCard title="Muscle priorities">
      <div style={CARD_GRID}>
        {props.rows.map((row) => (
          <div key={row.priority.id} style={cell}>
            <GoalMuscleCard
              name={priorityLabel(row.priority)}
              muscle={row.muscle}
              side={row.side}
              // VW-385 port removes this once titan >= 0.18.0 carries the statuses.
              status={titanStatus(row.rollup.status)}
              liftsOnTrack={row.rollup.progressingCount}
              liftsTotal={row.rollup.targetCount}
              commonGoalWeek={row.commonGoalWeek}
              lifts={row.lifts}
            />
          </div>
        ))}
      </div>
    </PanelCard>
  );
}

/** Sessions commitment, bodyweight tile (hidden with no VW-327 data) and the priority rail. */
function WholeBodyPanel(props: { data: GoalsPageData }): React.JSX.Element {
  const sessions = sessionsTarget(props.data);
  const bodyweight = bodyweightTarget(props.data);
  const tiles: MetricTileData[] = [];
  if (sessions !== null) {
    tiles.push({ label: 'Sessions (28d)', value: `${round1(sessions.view.committed)} committed` });
  }
  return (
    <PanelCard title="Whole body">
      {tiles.length > 0 && <MetricTiles metrics={tiles} gap={2} />}
      {bodyweight !== null && <BodyweightTile row={bodyweight} />}
      <div
        style={{
          display: 'flex',
          gap: SPACE.xs,
          flexWrap: 'wrap',
          marginTop: SPACE.md,
        }}
      >
        {props.data.priorities.map((row) => (
          <Pill key={row.priority.id} tone={levelTone(row.priority.level)} size="sm">
            {`${priorityLabel(row.priority)} · ${row.priority.level}`}
          </Pill>
        ))}
      </div>
    </PanelCard>
  );
}

/** Renders NOTHING (not a placeholder) with no VW-327 bodyweight data — `bodyweightTarget` already gates that. */
function BodyweightTile(props: { row: GoalTargetRow }): React.JSX.Element {
  const { view } = props.row;
  const latest = view.actuals[view.actuals.length - 1];
  return (
    <div style={{ marginTop: SPACE.md }}>
      <MetricTiles
        gap={2}
        metrics={[
          { label: 'Bodyweight', value: latest === undefined ? '—' : `${round1(latest.value)}` },
          { label: 'Band', value: `${round1(view.committed)}–${round1(view.stretch)}` },
        ]}
      />
    </div>
  );
}

function levelTone(level: StoredPriorityLevel): 'brand' | 'neutral' | 'warning' {
  switch (level) {
    case 'specialize':
      return 'brand';
    case 'maintain':
      return 'neutral';
    case 'deprioritize':
      return 'warning';
  }
}

function round1(value: number): string {
  return `${Math.round(value * 10) / 10}`;
}
