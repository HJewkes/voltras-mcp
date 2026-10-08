/**
 * One day on the `#/days` screen (VW-847 S4): what was done, and the Training / Test pick.
 *
 * Nothing is preselected, ever: the radio group's value is the owner's pick on this visit or
 * null, never the day's stored kind, so the screen never guesses a mark. In range mode
 * the pick is replaced by a tap that sets a bound, and the rows between the bounds highlight.
 *
 * Layout through `style`, colour through tokens (the SPA's react-native-web rule). Each `Radio`
 * states `aria-checked` itself because titan's emits no checked state on web.
 */
import React from 'react';
import {
  Badge,
  ListItem,
  Radio,
  RadioGroup,
  Surface,
  Typography,
  type BadgeColor,
} from '@titan-design/react-ui';

import type { ReviewDay, ReviewDayExercise } from '../../../analytics/session-review.js';
import type { MassUnit } from '../live-page/mass.js';
import { formatWeightLbs } from '../planner/planner-model.js';
import { RADIUS, SPACE } from '../planner/design.js';
import type { MarkKind } from './days-model.js';

export interface DayRowProps {
  day: ReviewDay;
  unit: MassUnit;
  narrow: boolean;
  /** `pick` shows the radio group; `range` makes the row a bound to tap. */
  mode: 'pick' | 'range';
  picked: MarkKind | null;
  inRange: boolean;
  disabled: boolean;
  onPick(kind: MarkKind): void;
  onTap(): void;
  /** The inline preview under the row, when this row is the one picked. */
  children?: React.ReactNode;
}

const KIND_BADGE: Record<ReviewDay['kind'], { label: string; color: BadgeColor }> = {
  unreviewed: { label: 'unreviewed', color: 'warning' },
  mixed: { label: 'mixed', color: 'info' },
  training: { label: 'training', color: 'success' },
  test: { label: 'test', color: 'default' },
};

/** `Tue Sep 15` from a local calendar date, read at local noon so no zone moves the day. */
export function dayHeading(day: string): string {
  const date = new Date(`${day}T12:00:00`);
  const weekday = date.toLocaleDateString('en-US', { weekday: 'short' });
  const rest = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${weekday} ${rest}`;
}

/** `Bench Press · 4 sets · top 135 lb`; the load only when the day recorded one. */
export function exerciseLine(exercise: ReviewDayExercise, unit: MassUnit): string {
  const parts = [exercise.name, `${String(exercise.sets)} ${exercise.sets === 1 ? 'set' : 'sets'}`];
  if (exercise.topLoadLbs !== undefined) {
    parts.push(`top ${formatWeightLbs(exercise.topLoadLbs, unit)}`);
  }
  return parts.join(' · ');
}

/** The span and the two flags a day can carry. */
export function dayFacts(day: ReviewDay): string {
  const facts = [`${String(Math.round(day.spanMinutes))} min`];
  if (!day.allEnded) facts.push('not ended');
  if (day.planned) facts.push('planned');
  return facts.join(' · ');
}

function DaySummary(props: { day: ReviewDay; unit: MassUnit }): React.JSX.Element {
  const badge = KIND_BADGE[props.day.kind];
  return (
    <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.xs }}>
        <Typography variant="subtitle1">{dayHeading(props.day.day)}</Typography>
        <Badge size="sm" variant="subtle" color={badge.color}>
          {badge.label}
        </Badge>
      </div>
      {props.day.exercises.map((exercise) => (
        <Typography key={exercise.exerciseId ?? exercise.name} variant="body2" color="secondary">
          {exerciseLine(exercise, props.unit)}
        </Typography>
      ))}
      <Typography variant="caption" color="tertiary">
        {dayFacts(props.day)}
      </Typography>
    </div>
  );
}

function KindPick(props: {
  day: string;
  picked: MarkKind | null;
  disabled: boolean;
  onPick(kind: MarkKind): void;
}): React.JSX.Element {
  return (
    <RadioGroup
      value={props.picked}
      onChange={(value) => props.onPick(value as MarkKind)}
      orientation="horizontal"
      isDisabled={props.disabled}
      aria-label={`Mark ${props.day}`}
    >
      <Radio value="training" aria-checked={props.picked === 'training'}>
        Training
      </Radio>
      <Radio value="test" aria-checked={props.picked === 'test'}>
        Test
      </Radio>
    </RadioGroup>
  );
}

export function DayRow(props: DayRowProps): React.JSX.Element {
  const body = (
    <div
      style={{
        display: 'flex',
        flexDirection: props.narrow ? 'column' : 'row',
        alignItems: props.narrow ? 'stretch' : 'center',
        gap: SPACE.sm,
        width: '100%',
      }}
    >
      <DaySummary day={props.day} unit={props.unit} />
      {props.mode === 'pick' && (
        <KindPick
          day={props.day.day}
          picked={props.picked}
          disabled={props.disabled}
          onPick={props.onPick}
        />
      )}
    </div>
  );
  return (
    <Surface
      level="raised"
      testID={`day-row-${props.day.day}`}
      aria-selected={props.inRange}
      style={{
        borderRadius: RADIUS.card,
        borderWidth: 1,
        borderColor: props.inRange ? 'var(--color-brand-primary)' : 'transparent',
        overflow: 'hidden',
      }}
    >
      {props.mode === 'range' ? (
        <ListItem onPress={props.onTap} aria-label={`Range bound ${props.day.day}`}>
          {body}
        </ListItem>
      ) : (
        <ListItem>{body}</ListItem>
      )}
      {props.children}
    </Surface>
  );
}
