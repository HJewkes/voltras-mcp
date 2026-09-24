/**
 * The `#/goals` wall page's pure render (VW-355, plan G8').
 *
 * Split from `GoalsPage` (the fetch wrapper) so this component takes the two
 * fetched payloads as props and nothing else — no store read, no fetch, no
 * clock — which is what lets the render test hand it `/api/goal-progress`
 * fixtures directly (plan G8' done_when).
 *
 * ── Layout ───────────────────────────────────────────────────────────────
 * The lead lift as titan's full `GoalCard` (title row, folded block-end
 * summary with its week cells, trajectory chart), then a grid of compact
 * `GoalCard`s, then a grid of `GoalMuscleCard`, then the whole-body cards and the
 * priority index, drawn only when a whole-body goal exists (VW-455). Sections come from plan G8'/§4,
 * not invented here. The old header block is gone rather than restyled
 * (VW-385): the week, committed/stretch, next target and status basis each
 * read off something the card already draws.
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
 * Phone (VW-356): below `NARROW_BREAKPOINT_PX` the two grids collapse to one
 * full-width column (`useIsNarrowViewport`, same hook the planner and `#/body`
 * pages use). The lead card measures its own box, so its chart follows the
 * viewport without a width of ours.
 */
import React from 'react';
import { Text } from 'react-native';
import {
  BodyweightGoalCard,
  EmptyState,
  GoalCard,
  GoalPriorityIndex,
  SessionsGoalCard,
  Surface,
  Typography,
  useOnSurfaceColor,
} from '@titan-design/react-ui';
import { GoalMuscleCard } from '@titan-design/react-ui/bodymap';

import { PANEL_GAP } from '../planner/PanelCard.js';
import { SPACE } from '../planner/design.js';
import { PAGE_PADDING } from '../planner/PlanBuilderPage.js';
import { useIsNarrowViewport } from '../use-viewport.js';
import { calibrationLine } from './calibration-copy.js';
import {
  cardChart,
  cardMilestone,
  cardTrend,
  hasPR,
  liftRows,
  muscleCardRows,
  priorityLabel,
  primaryTarget,
  targetLabel,
  type GoalMuscleCardRow,
  type GoalTargetRow,
  type GoalsPageData,
} from './goals-model.js';
import { priorityIndexEntries, wholeBodyCards } from './whole-body-cards.js';

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
      {primary !== null && <PrimaryGoalCard row={primary} />}
      <PerLiftGrid rows={liftRows(data)} narrow={narrow} />
      <MuscleGrid rows={muscleCardRows(data)} narrow={narrow} />
      <WholeBodySection data={data} narrow={narrow} />
    </Surface>
  );
}

/** The lead priority's lift as the full goal card (plan §4, wall; VW-385). */
function PrimaryGoalCard(props: { row: GoalTargetRow }): React.JSX.Element {
  const { priority, view } = props.row;
  return (
    <WithCalibrationNote view={view} chartShowsNote>
      <GoalCard
        size="full"
        title={priorityLabel(priority)}
        priority={priority.level}
        status={view.status}
        basis={view.statusBasis}
        isPR={hasPR(view)}
        milestone={cardMilestone(view)}
        goal={cardChart(view)}
      />
    </WithCalibrationNote>
  );
}

/**
 * The line under a card about calibration (VW-444): a calibrating target's plain
 * sentence, or the line an accepted starting ramp carries once its lift has
 * calibrated. A card whose chart states the wait in the plot (`chartShowsNote`,
 * the full card) drops the sentence rather than say the count twice (human,
 * review round); the compact card's chart has no note, so it keeps it.
 */
function WithCalibrationNote(props: {
  view: GoalTargetRow['view'];
  chartShowsNote?: boolean;
  children: React.JSX.Element;
}): React.JSX.Element {
  const color = useOnSurfaceColor('secondary');
  const inPlot = props.chartShowsNote === true && props.view.calibration !== undefined;
  const line = inPlot ? null : calibrationLine(props.view);
  if (line === null) return props.children;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.xs }}>
      {props.children}
      <Text style={{ color, fontSize: 14 }}>{line}</Text>
    </div>
  );
}

/**
 * Auto-fill columns no narrower than `CARD_MIN_WIDTH`: four at 1920, three at
 * 1440 (human decision, VW-385). `flex-*` classNames are not an option here:
 * these grids sit inside react-native-web Views, which drop Tailwind layout
 * utilities, so the geometry is inline `style` (same rule as the planner pages).
 */
const CARD_MIN_WIDTH = 420;

/**
 * The phone column. `minmax(0, 1fr)`, not `1fr`: a bare `1fr` floors the track at the
 * card's min-content, and a compact card's charts start at titan's default width before
 * the card measures itself, so the column locked wider than the page (VW-454).
 */
const NARROW_COLUMN = 'minmax(0, 1fr)';

/** Narrow (VW-356): one full-width column; the wall's minimum is wider than a phone's content box. */
function cardGridStyle(narrow: boolean): React.CSSProperties {
  return {
    display: 'grid',
    gridTemplateColumns: narrow
      ? NARROW_COLUMN
      : `repeat(auto-fill, minmax(${CARD_MIN_WIDTH}px, 1fr))`,
    gap: SPACE.md,
    alignItems: 'stretch',
  };
}

/**
 * A group of goal cards titled on the page background (VW-435, VW-454): the cards
 * are the first elevated surface, not cards inside a panel, so they get the panel's
 * gutter back as width. The title is the full goal card's heading type (a heading
 * variant, all caps) at section size, cased by style so the string stays as written.
 */
function PageSection(props: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: SPACE.sm }}>
      <Typography variant="h6" style={{ textTransform: 'uppercase' }}>
        {props.title}
      </Typography>
      {props.children}
    </section>
  );
}

/** One card per exercise-tracked target (`top_load_at_reps`). */
function PerLiftGrid(props: { rows: GoalTargetRow[]; narrow: boolean }): React.JSX.Element | null {
  if (props.rows.length === 0) return null;
  return (
    <PageSection title="Per-lift">
      <div style={cardGridStyle(props.narrow)}>
        {props.rows.map((row) => (
          <WithCalibrationNote key={row.view.target.id} view={row.view}>
            <GoalCard
              size="compact"
              title={targetLabel(row)}
              priority={row.priority.level}
              status={row.view.status}
              basis={row.view.statusBasis}
              isPR={hasPR(row.view)}
              milestone={cardMilestone(row.view)}
              trend={cardTrend(row.view)}
            />
          </WithCalibrationNote>
        ))}
      </div>
    </PageSection>
  );
}

/** One card per `muscle`-kind priority, from its rollup and its contributing lifts. */
function MuscleGrid(props: {
  rows: GoalMuscleCardRow[];
  narrow: boolean;
}): React.JSX.Element | null {
  if (props.rows.length === 0) return null;
  return (
    <PageSection title="Muscle priorities">
      <div style={cardGridStyle(props.narrow)}>
        {props.rows.map((row) => (
          <GoalMuscleCard
            key={row.priority.id}
            name={priorityLabel(row.priority)}
            muscle={row.muscle}
            side={row.side}
            status={row.rollup.status}
            liftsOnTrack={row.rollup.progressingCount}
            liftsTotal={row.rollup.targetCount}
            commonGoalWeek={row.commonGoalWeek}
            lifts={row.lifts}
          />
        ))}
      </div>
    </PageSection>
  );
}

/**
 * Bodyweight and sessions as sibling cards in the page grid, then every declared
 * priority on one line; nothing without a whole-body goal (VW-454, VW-455). The
 * cards level their heights by filling the grid row.
 */
function WholeBodySection(props: {
  data: GoalsPageData;
  narrow: boolean;
}): React.JSX.Element | null {
  const cards = wholeBodyCards(props.data);
  if (cards === null) return null;
  return (
    <PageSection title="Whole body">
      <div style={cardGridStyle(props.narrow)}>
        {cards.bodyweight !== null && (
          <BodyweightGoalCard goal={cards.bodyweight} style={{ height: '100%' }} />
        )}
        {cards.sessions !== null && (
          <SessionsGoalCard goal={cards.sessions} style={{ height: '100%' }} />
        )}
      </div>
      <GoalPriorityIndex priorities={priorityIndexEntries(props.data)} />
    </PageSection>
  );
}
