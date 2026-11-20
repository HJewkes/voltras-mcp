import React from 'react';
import { useStore } from 'zustand';
import { Caption, Pill, Typography } from '@titan-design/react-ui';

import { SUMMARY_FRAGMENTS as LINES } from '../../../../coach-copy/dashboard.js';
import { dashboardStore } from '../../store';
import { UnitToggle } from '../../UnitToggle';
import { type MassUnit } from '../../live-page/mass';
import { formatWeightLbs } from '../planner-model';
import { headerTotals, type HeaderTotals } from '../session-summary-model';
import { SPACE, TABULAR } from '../design';
import { TipLabel } from './TipLabel';
import type { SessionSummaryView } from '../../../read-models/session-summary-view';

/** Title, when it ran, the session totals, the withheld-RIR marker and the unit toggle. */
export function SummaryHeader(props: {
  summary: SessionSummaryView;
  displayUnit: MassUnit;
}): React.JSX.Element {
  const setDisplayUnit = useStore(dashboardStore, (s) => s.setDisplayUnit);
  const open = props.summary.session.endedAt === null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.md, flexWrap: 'wrap' }}>
      <Typography variant="h4">{open ? 'Session in progress' : 'Session complete'}</Typography>
      <Caption color="secondary">{timeLine(props.summary)}</Caption>
      {open && (
        <Pill size="sm" variant="subtle" tone="info">
          Session still open
        </Pill>
      )}
      <div style={{ flex: '1 1 0' }} />
      <Typography variant="subtitle1" style={TABULAR}>
        {totalsLine(headerTotals(props.summary), props.displayUnit)}
      </Typography>
      <TipLabel label={LINES.rirCalibratingLabel.text} tip={LINES.rirCalibratingTip.text} />
      <UnitToggle unit={props.displayUnit} onChange={setDisplayUnit} placement="inline" />
    </div>
  );
}

function timeLine(summary: SessionSummaryView): string {
  const { startedAt, endedAt } = summary.session;
  const start = new Date(startedAt).toLocaleString();
  return endedAt === null ? start : `${start} → ${new Date(endedAt).toLocaleTimeString()}`;
}

function totalsLine(totals: HeaderTotals, unit: MassUnit): string {
  const volume =
    totals.unloadedLabel === null
      ? formatWeightLbs(totals.volumeLbs, unit)
      : `${formatWeightLbs(totals.volumeLbs, unit)} (${totals.unloadedLabel})`;
  return [
    plural(totals.exerciseCount, 'exercise'),
    plural(totals.setCount, 'set'),
    plural(totals.totalReps, 'rep'),
    volume,
    ...(totals.durationMin === null ? [] : [`${totals.durationMin} min`]),
  ].join(' · ');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
