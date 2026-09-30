/**
 * `#/goals` page body (VW-355, plan G8'): the loading, error and loaded states
 * of one {@link GoalsPollState}. The poll itself lives in `useGoalsPoll`, owned
 * by `GoalsRoute`, so the page and the chrome's header slot read one fetch.
 */
import React from 'react';
import { Caption, Spinner, Surface } from '@titan-design/react-ui';

import { GoalsView } from './GoalsView.js';
import type { GoalsPollState } from './use-goals-poll.js';
import { ErrorNote, PAGE_PADDING } from '../planner/PlanBuilderPage.js';
import { PANEL_GAP } from '../planner/PanelCard.js';
import { SPACE } from '../planner/design.js';

export function GoalsPage({ poll }: { poll: GoalsPollState }): React.JSX.Element {
  if (poll.error !== null) {
    return (
      <Surface level="base" style={{ minHeight: '100%', padding: PAGE_PADDING, gap: PANEL_GAP }}>
        <ErrorNote message={poll.error} />
      </Surface>
    );
  }
  if (poll.data === null) {
    return (
      <Surface
        level="base"
        style={{ minHeight: '100%', padding: PAGE_PADDING, alignItems: 'center', gap: SPACE.sm }}
      >
        <Spinner />
        <Caption color="tertiary">Loading goals…</Caption>
      </Surface>
    );
  }
  return <GoalsView data={poll.data} />;
}
