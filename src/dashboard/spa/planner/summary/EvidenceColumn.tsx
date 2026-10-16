import React from 'react';
import { Caption, Typography } from '@titan-design/react-ui';

import { selectWorkingSets } from '../../../../store/working-sets.js';
import { type MassUnit } from '../../live-page/mass';
import { setLoad, visibleSets } from '../planner-model';
import { fatigueFact, setKind, strengthFact } from '../session-summary-model';
import { SPACE, TABULAR } from '../design';
import type {
  SessionSummaryExercise,
  SessionSummarySet,
} from '../../../read-models/session-summary-view';

const SET_COLUMN_WIDTH = 80;

/** The two session facts, then one column per set: reps, load and velocity loss. */
export function EvidenceColumn(props: {
  exercise: SessionSummaryExercise;
  displayUnit: MassUnit;
}): React.JSX.Element {
  const facts = [fatigueFact(props.exercise), strengthFact(props.exercise, props.displayUnit)];
  const working = new Set(selectWorkingSets(props.exercise.sets));
  return (
    <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      <Typography variant="subtitle1" style={TABULAR}>
        {facts.filter((fact) => fact !== null).join('   ') || ' '}
      </Typography>
      <div style={{ display: 'flex', gap: SPACE.xxs, marginTop: SPACE.xxs }}>
        {visibleSets(props.exercise).map((set) => (
          <SetColumn
            key={set.id}
            set={set}
            working={working.has(set)}
            displayUnit={props.displayUnit}
          />
        ))}
      </div>
    </div>
  );
}

// A set outside the working sets reads quieter: secondary ink, and its purpose named.
function SetColumn(props: {
  set: SessionSummarySet;
  working: boolean;
  displayUnit: MassUnit;
}): React.JSX.Element {
  const { set } = props;
  const ink = props.working ? 'primary' : 'secondary';
  const load = setLoad(set, props.displayUnit);
  const loss = set.velocityLossPct === null ? '—' : `VL${Math.round(set.velocityLossPct)}%`;
  return (
    <div style={{ width: SET_COLUMN_WIDTH, display: 'flex', flexDirection: 'column' }}>
      <Caption color="secondary">
        {props.working ? `#${set.index}` : `#${set.index} ${setKind(set, false)}`}
      </Caption>
      <Typography variant="h5" color={ink} style={TABULAR}>
        {set.repCount}
      </Typography>
      <Caption color={ink}>{load}</Caption>
      <Caption color="secondary">{loss}</Caption>
    </div>
  );
}
