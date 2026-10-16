import React from 'react';
import {
  Caption,
  Overline,
  Pill,
  TipTrigger,
  TrendingDownIcon,
  TrendingUpIcon,
  Typography,
} from '@titan-design/react-ui';

import { SUMMARY_FRAGMENTS as LINES } from '../../../../coach-copy/dashboard.js';
import { fillSlots } from '../../../../coach-copy/fill.js';
import { type MassUnit } from '../../live-page/mass';
import { formatWeightLbs } from '../planner-model';
import {
  disagreement,
  nextLoad,
  nextTimeChip,
  repMarks,
  repScheme,
  serverProse,
  usualRange,
  type Disagreement,
  type RepMark,
} from '../session-summary-model';
import { SPACE, TABULAR } from '../design';
import { TipLabel } from './TipLabel';
import type {
  SessionSummaryExercise,
  SessionSummaryProgression,
} from '../../../read-models/session-summary-view';

export const NEXT_TIME_COLUMN_WIDTH = 340;

const DISAGREEMENT_COPY: Record<Disagreement, { label: string; tip: string }> = {
  'moved-well-missed-reps': {
    label: LINES.movedWellMissedRepsLabel.text,
    tip: LINES.movedWellMissedRepsTip.text,
  },
  'moved-well-plan-backs-off': {
    label: LINES.movedWellPlanBacksOffLabel.text,
    tip: LINES.movedWellPlanBacksOffTip.text,
  },
  'struggled-plan-adds': {
    label: LINES.struggledPlanAddsLabel.text,
    tip: LINES.struggledPlanAddsTip.text,
  },
};

type ColumnProps = { exercise: SessionSummaryExercise; displayUnit: MassUnit };

/** Next session's load and step, the rep evidence it scored, and any caveat beside it. */
export function NextTimeColumn(props: ColumnProps): React.JSX.Element {
  const { progression } = props.exercise;
  return (
    <div style={{ width: NEXT_TIME_COLUMN_WIDTH, display: 'flex', flexDirection: 'column' }}>
      <Overline color="secondary">{LINES.nextTimeKickerLabel.text}</Overline>
      {progression === null ? (
        <TipLabel
          variant="h5"
          label="No recommendation"
          tip={props.exercise.progressionNote ?? 'Nothing to progress.'}
        />
      ) : (
        <Recommendation {...props} progression={progression} />
      )}
      <Caveats {...props} />
    </div>
  );
}

function Recommendation(
  props: ColumnProps & { progression: SessionSummaryProgression },
): React.JSX.Element {
  const chip = nextTimeChip(props.exercise, props.displayUnit) ?? '';
  const load = nextLoad(props.exercise);
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.sm }}>
        {/* No load to move from (a band or damper lift): the step alone is the advice. */}
        {load !== null && (
          <Typography variant="h3" style={TABULAR}>
            {formatWeightLbs(load, props.displayUnit)}
          </Typography>
        )}
        <TipTrigger
          label={chip}
          content={
            <Typography variant="body2">
              {serverProse(props.progression.reasoning, props.displayUnit)}
            </Typography>
          }
        >
          {/* Neutral, never a status tone: a back-off is a plan, not an alarm. */}
          <Pill size="md" variant="outline" tone="neutral">
            {chip}
          </Pill>
        </TipTrigger>
      </div>
      <RepEvidence exercise={props.exercise} />
    </>
  );
}

function RepEvidence(props: { exercise: SessionSummaryExercise }): React.JSX.Element {
  const scheme = repScheme(props.exercise);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.xxs, flexWrap: 'wrap' }}>
      {scheme !== null && <Caption color="secondary">{scheme}</Caption>}
      {repMarks(props.exercise).map((mark) => (
        <RepChip key={mark.index} mark={mark} />
      ))}
    </div>
  );
}

const MARK_WORD: Record<RepMark['mark'], string> = {
  over: 'top of the band',
  in: 'in the band',
  under: 'short of the band',
};

function RepChip(props: { mark: RepMark }): React.JSX.Element {
  const { mark } = props;
  const icon =
    mark.mark === 'under' ? (
      <TrendingDownIcon size={12} />
    ) : mark.mark === 'over' ? (
      <TrendingUpIcon size={12} />
    ) : undefined;
  return (
    <Pill
      size="sm"
      variant="outline"
      tone="neutral"
      leading={icon}
      accessibilityLabel={`Set ${mark.index}: ${mark.repCount} reps, ${MARK_WORD[mark.mark]}`}
    >
      {`${mark.repCount}`}
    </Pill>
  );
}

function Caveats(props: ColumnProps): React.JSX.Element {
  const kind = disagreement(props.exercise);
  const range = usualRange(props.exercise);
  const drift = props.exercise.loadDrift;
  return (
    <div style={{ display: 'flex', gap: SPACE.sm, flexWrap: 'wrap' }}>
      {range !== null && (
        <TipLabel
          label={fillSlots(LINES.usualRangeLabel.text, {
            low: `${range.expectedLow}`,
            high: `${range.expectedHigh}`,
          })}
          tip={fillSlots(LINES.usualRangeTip.text, { basis: range.basis })}
        />
      )}
      {kind !== null && <TipLabel {...DISAGREEMENT_COPY[kind]} />}
      {drift !== null && (
        <TipLabel
          label={`Load drift ${signed(drift.deltaPct)} pts`}
          tip={serverProse(drift.reason, props.displayUnit)}
        />
      )}
    </div>
  );
}

function signed(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : rounded < 0 ? `−${-rounded}` : '0';
}
