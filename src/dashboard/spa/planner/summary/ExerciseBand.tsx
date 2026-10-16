import React from 'react';
import { Surface } from '@titan-design/react-ui';

import { type MassUnit } from '../../live-page/mass';
import { RADIUS, SPACE } from '../design';
import { EvidenceColumn } from './EvidenceColumn';
import { NextTimeColumn } from './NextTimeColumn';
import { VerdictColumn } from './VerdictColumn';
import type { SessionSummaryExercise } from '../../../read-models/session-summary-view';

/**
 * One exercise, read left to right: how it moved, the sets behind that, and
 * what next time holds. One raised plane per band and no tone border; the
 * verdict word carries the tone.
 */
export function ExerciseBand(props: {
  exercise: SessionSummaryExercise;
  displayUnit: MassUnit;
}): React.JSX.Element {
  return (
    <Surface level="raised" style={{ borderRadius: RADIUS.card, overflow: 'hidden' }}>
      <div
        data-testid="summary-band"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: SPACE.xl,
          paddingLeft: SPACE.lg,
          paddingRight: SPACE.lg,
          paddingTop: SPACE.sm,
          paddingBottom: SPACE.sm,
        }}
      >
        <VerdictColumn exercise={props.exercise} />
        <EvidenceColumn exercise={props.exercise} displayUnit={props.displayUnit} />
        <NextTimeColumn exercise={props.exercise} displayUnit={props.displayUnit} />
      </div>
    </Surface>
  );
}
