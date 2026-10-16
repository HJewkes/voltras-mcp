import React from 'react';
import {
  Overline,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from '@titan-design/react-ui';

import { selectWorkingSets } from '../../../../store/working-sets.js';
import { type MassUnit } from '../../live-page/mass';
import { formatNumber, formatWeightLbs, setLoad, visibleSets } from '../planner-model';
import { e1rmBySet, setKind } from '../session-summary-model';
import { SPACE } from '../design';
import type { SessionSummaryExercise } from '../../../read-models/session-summary-view';

// react-native-web's base View rules beat the row's `flex-row` class, so the row says it in style.
const ROW = { flexDirection: 'row' } as const;
const COLUMNS = ['Set', 'Kind', 'Reps', 'Load', 'VL', 'Best m/s', 'e1RM'] as const;

/** Every set of the session, grouped by exercise: the raw record under the bands. */
export function SetRecordTable(props: {
  exercises: readonly SessionSummaryExercise[];
  displayUnit: MassUnit;
}): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.xs }}>
      <Overline color="secondary">Sets</Overline>
      <Table density="dense">
        <TableHeader>
          <TableRow style={ROW} isHoverable={false}>
            <TableHeaderCell>Exercise</TableHeaderCell>
            {COLUMNS.map((column) => (
              <TableHeaderCell key={column} width={96} align="right">
                {column}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {props.exercises.flatMap((exercise) => exerciseRows(exercise, props.displayUnit))}
        </TableBody>
      </Table>
    </div>
  );
}

function exerciseRows(exercise: SessionSummaryExercise, unit: MassUnit): React.JSX.Element[] {
  const working = new Set(selectWorkingSets(exercise.sets));
  const e1rm = new Map(e1rmBySet(exercise).map((s) => [s.index, s.e1rm]));
  return visibleSets(exercise).map((set, position) => (
    <TableRow key={set.id} style={ROW}>
      <TableCell>{position === 0 ? exercise.name : ''}</TableCell>
      {[
        `#${set.index}`,
        setKind(set, working.has(set)),
        `${set.repCount}`,
        setLoad(set, unit),
        set.velocityLossPct === null ? '—' : `${formatNumber(set.velocityLossPct)}%`,
        formatNumber(set.bestRepVelocity),
        formatWeightLbs(e1rm.get(set.index), unit),
      ].map((value, column) => (
        <TableCell key={COLUMNS[column]} width={96} align="right">
          {value}
        </TableCell>
      ))}
    </TableRow>
  ));
}
