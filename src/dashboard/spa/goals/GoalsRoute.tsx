/**
 * `#/goals` inside the shared chrome (VW-654, VW-466 slice 8).
 *
 * The route owns the poll so one fetch can feed two readers: the page body and
 * the chrome's pinned `header` slot, which the mesocycle header fills next
 * (VW-655). Until then the slot is empty and the chrome renders as before.
 */
import React from 'react';

import { DashboardChrome } from '../panels/DashboardChrome.js';
import { GoalsPage } from './GoalsPage.js';
import { useGoalsPoll } from './use-goals-poll.js';

export function GoalsRoute(): React.JSX.Element {
  const poll = useGoalsPoll();
  return (
    <DashboardChrome route={{ name: 'goals' }} scroll>
      <GoalsPage poll={poll} />
    </DashboardChrome>
  );
}
