/**
 * The `#/goals` wall page's pure render (VW-355, plan G8').
 *
 * Split from `GoalsPage` (the fetch wrapper) so this component takes the two
 * fetched payloads as props and nothing else — no store read, no fetch, no
 * clock — which is what lets the render test hand it `/api/goal-progress`
 * fixtures directly (plan G8' done_when).
 *
 * ── Layout ───────────────────────────────────────────────────────────────
 * Wall only (phone is VW-356): priority header + `GoalTrajectoryChart` +
 * milestone tiles, then a per-lift table, then muscle rollup rows, then a
 * whole-body panel with the priority rail and the bodyweight tile. Sections
 * come from plan G8'/§4, not invented here.
 *
 * LAYOUT via `style`, never `className` — same rule as the planner pages;
 * titan components are react-native-web Views that silently drop Tailwind
 * layout utilities. Colour comes from `<Surface level>` / `useOnSurfaceColor`
 * / semantic tokens only, never a raw hex.
 */
import React from 'react';
import {
  Caption,
  EmptyState,
  GoalTrajectoryChart,
  MesoStatusCard,
  MetricTiles,
  Pill,
  PrBadge,
  Surface,
  Typography,
  type MetricTileData,
} from '@titan-design/react-ui';

import type { StoredPriorityLevel } from '../../../store/types.js';
import { PanelCard, PANEL_GAP } from '../planner/PanelCard.js';
import { SPACE } from '../planner/design.js';
import { PAGE_PADDING } from '../planner/PlanBuilderPage.js';
import {
  bodyweightTarget,
  chartWeeks,
  dateOnly,
  directionOf,
  liftRows,
  mesoSubtitle,
  muscleRollupRows,
  priorityLabel,
  primaryTarget,
  sessionsTarget,
  statusBadgeVariant,
  statusLabel,
  targetLabel,
  type GoalTargetRow,
  type GoalsPageData,
} from './goals-model.js';

const CHART_WIDTH = 1200;
const CHART_HEIGHT = 340;

export function GoalsView(props: { data: GoalsPageData }): React.JSX.Element {
  const { data } = props;
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
      {primary !== null && <PrimaryGoalCard row={primary} />}
      <PerLiftTable rows={liftRows(data)} />
      <MuscleRollupPanel rows={muscleRollupRows(data)} />
      <WholeBodyPanel data={data} />
    </Surface>
  );
}

/** Header + `GoalTrajectoryChart` + milestone tile for the lead priority (plan §4, wall). */
function PrimaryGoalCard(props: { row: GoalTargetRow }): React.JSX.Element {
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
          status={view.status}
          direction={directionOf(view)}
          width={CHART_WIDTH}
          height={CHART_HEIGHT}
          metricLabel={priorityLabel(priority)}
        />
      </div>
    </PanelCard>
  );
}

/** One row per exercise-tracked target (`top_load_at_reps`). */
function PerLiftTable(props: { rows: GoalTargetRow[] }): React.JSX.Element | null {
  if (props.rows.length === 0) return null;
  return (
    <PanelCard title="Per-lift">
      {props.rows.map((row) => (
        <div
          key={row.view.target.id}
          style={{
            display: 'flex',
            gap: SPACE.sm,
            alignItems: 'center',
            paddingTop: SPACE.xs,
            paddingBottom: SPACE.xs,
          }}
        >
          <div style={{ flex: '1 1 0', minWidth: 0 }}>
            <Typography variant="body2">{targetLabel(row)}</Typography>
          </div>
          <div style={{ width: 140 }}>
            <Pill tone={statusBadgeVariant(row.view.status)} size="sm">
              {statusLabel(row.view.status)}
            </Pill>
          </div>
          <div style={{ width: 220 }}>
            <Caption color="tertiary">{row.view.nextMilestone.label}</Caption>
          </div>
        </div>
      ))}
    </PanelCard>
  );
}

/** One row per `muscle`-kind priority, from its already-computed rollup. */
function MuscleRollupPanel(props: {
  rows: ReturnType<typeof muscleRollupRows>;
}): React.JSX.Element | null {
  const withRollup = props.rows.flatMap((row) =>
    row.rollup === null ? [] : [{ priority: row.priority, rollup: row.rollup }],
  );
  if (withRollup.length === 0) return null;
  return (
    <PanelCard title="Muscle priorities">
      {withRollup.map(({ priority, rollup }) => (
        <div
          key={priority.id}
          style={{
            display: 'flex',
            gap: SPACE.sm,
            alignItems: 'center',
            paddingTop: SPACE.xs,
            paddingBottom: SPACE.xs,
          }}
        >
          <div style={{ flex: '1 1 0', minWidth: 0 }}>
            <Typography variant="body2">{priorityLabel(priority)}</Typography>
          </div>
          <div style={{ width: 140 }}>
            <Pill tone={statusBadgeVariant(rollup.status)} size="sm">
              {statusLabel(rollup.status)}
            </Pill>
          </div>
          <div style={{ width: 260 }}>
            <Caption color="tertiary">{rollup.summary}</Caption>
          </div>
        </div>
      ))}
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
