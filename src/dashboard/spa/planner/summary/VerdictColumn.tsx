import React from 'react';
import {
  FatigueLights,
  Overline,
  Pill,
  STATE_LABEL,
  TONE_TOKEN,
  Typography,
  getSemanticColors,
  useSurfaceMode,
} from '@titan-design/react-ui';

import { SUMMARY_FRAGMENTS as LINES } from '../../../../coach-copy/dashboard.js';
import { absentReason, verdictKicker, type AbsentReason } from '../session-summary-model';
import { SPACE } from '../design';
import { TipLabel } from './TipLabel';
import type { SessionSummaryExercise } from '../../../read-models/session-summary-view';

export const VERDICT_COLUMN_WIDTH = 480;

const ABSENT_COPY: Record<AbsentReason, { label: string; tip: string }> = {
  'not-scored': { label: LINES.notScoredLabel.text, tip: LINES.notScoredTip.text },
  'no-bar-speed': { label: LINES.noBarSpeedLabel.text, tip: LINES.noBarSpeedTip.text },
  'no-verdict': { label: LINES.noVerdictLabel.text, tip: LINES.noVerdictTip.text },
};

/** Exercise name, the set the verdict read, and the verdict word with its three lights. */
export function VerdictColumn(props: {
  exercise: SessionSummaryExercise;
  narrow: boolean;
}): React.JSX.Element {
  const { exercise } = props;
  const kicker = verdictKicker(exercise);
  const reason = absentReason(exercise);
  return (
    <div
      style={{
        width: props.narrow ? '100%' : VERDICT_COLUMN_WIDTH,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <ExerciseTitle exercise={exercise} />
      <Overline color="secondary">
        {[LINES.howItMovedKickerLabel.text, kicker].filter((part) => part !== null).join(' · ')}
      </Overline>
      {exercise.verdict !== null && <VerdictWord verdict={exercise.verdict} />}
      {reason !== null && <TipLabel variant="h5" {...ABSENT_COPY[reason]} />}
    </div>
  );
}

function ExerciseTitle(props: { exercise: SessionSummaryExercise }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.xs }}>
      <Typography variant="h5">{props.exercise.name}</Typography>
      {props.exercise.exerciseId === null && (
        <Pill size="sm" variant="outline" tone="neutral">
          no exercise named
        </Pill>
      )}
    </div>
  );
}

// Tone in colour only on the h2 word, where large text needs 3:1. On titan 0.21.2 dark
// `status-error` (#D14343) measures 2.88:1 on the raised plane, so alarm uses its light step
// (#E05254, 3.45:1).
const VERDICT_INK = { ...TONE_TOKEN, alarm: 'status-error-light' } as const;

function VerdictWord(props: {
  verdict: NonNullable<SessionSummaryExercise['verdict']>;
}): React.JSX.Element {
  const colors = getSemanticColors(useSurfaceMode());
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.md, flexWrap: 'wrap' }}>
      <Typography variant="h2" style={{ color: colors[VERDICT_INK[props.verdict.tone]] }}>
        {STATE_LABEL[props.verdict.state]}
      </Typography>
      <FatigueLights dimensions={props.verdict.dimensions} />
    </div>
  );
}
