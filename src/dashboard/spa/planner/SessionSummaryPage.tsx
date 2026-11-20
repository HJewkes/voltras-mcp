/**
 * Session-completion page (VW-120), laid out as a ledger (VW-944).
 *
 * One band per exercise the session TOUCHED — VW-114's `session.set_exercise`
 * means a session routinely spans several, so nothing here assumes one exercise
 * per session; the grouping is done server-side in `session-summary.ts` from each
 * set's own `exerciseId`. Each band reads left to right: how it moved (the
 * verdict and the set it read), the sets behind that, and next time's load.
 * The raw set table sits below the bands, under the fold on the wall.
 *
 * Every number and choice comes from `session-summary-model.ts`; the files in
 * `summary/` are markup. Explanations sit behind tips, per titan's design floor.
 *
 * Loads once per session id (a finished session's numbers don't move), so this
 * page does not poll.
 *
 * LAYOUT via `style`, never `className` — react-native-web silently drops
 * Tailwind layout utilities. Same rule the live page follows.
 */
import React, { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { Caption, EmptyState, Spinner, Surface } from '@titan-design/react-ui';

import { dashboardStore } from '../store';
import { fetchSessionSummary } from './planner-client';
import { ErrorNote, PAGE_PADDING } from './PlanBuilderPage';
import { SPACE } from './design';
import { ExerciseBand } from './summary/ExerciseBand';
import { SetRecordTable } from './summary/SetRecordTable';
import { SummaryHeader } from './summary/SummaryHeader';
import type { SessionSummaryView } from '../../read-models/session-summary-view';

export function SessionSummaryPage(props: { sessionId: string }): React.JSX.Element {
  const summary = useStore(dashboardStore, (s) => s.sessionSummary);
  const error = useStore(dashboardStore, (s) => s.plannerError);
  const absent = useSummaryLoad(props.sessionId);

  if (error !== null)
    return (
      <PagePlane>
        <ErrorNote message={error} />
      </PagePlane>
    );
  if (absent) {
    return (
      <PagePlane>
        {props.sessionId === 'latest' ? (
          <EmptyState title="No sessions yet" description="Finish a session to see it here." />
        ) : (
          <EmptyState title="Session not found" />
        )}
      </PagePlane>
    );
  }
  if (summary === null) {
    return (
      <PagePlane>
        <Spinner />
        <Caption color="secondary">Loading session summary…</Caption>
      </PagePlane>
    );
  }
  return <Ledger summary={summary} />;
}

/** Fetches the summary into the store; true once the route answered that there is none. */
function useSummaryLoad(sessionId: string): boolean {
  const [absent, setAbsent] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchSessionSummary(sessionId).then(
      (loaded) => {
        if (cancelled) return;
        setAbsent(loaded === null);
        dashboardStore.getState().applyPlanner({ sessionSummary: loaded, plannerError: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        dashboardStore
          .getState()
          .applyPlanner({ sessionSummary: null, plannerError: (err as Error).message });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  return absent;
}

function PagePlane(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Surface level="base" style={{ minHeight: '100%', padding: PAGE_PADDING, gap: SPACE.sm }}>
      {props.children}
    </Surface>
  );
}

function Ledger(props: { summary: SessionSummaryView }): React.JSX.Element {
  const displayUnit = useStore(dashboardStore, (s) => s.displayUnit);
  const { exercises } = props.summary;
  return (
    <PagePlane>
      <SummaryHeader summary={props.summary} displayUnit={displayUnit} />
      {exercises.length === 0 ? (
        <EmptyState
          title="No sets recorded"
          description="This session ended without a completed set."
        />
      ) : (
        exercises.map((exercise) => (
          <ExerciseBand
            key={exercise.exerciseId ?? 'unattributed'}
            exercise={exercise}
            displayUnit={displayUnit}
          />
        ))
      )}
      {exercises.length > 0 && <SetRecordTable exercises={exercises} displayUnit={displayUnit} />}
    </PagePlane>
  );
}
