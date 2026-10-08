/**
 * `#/days`, "Review days" (VW-847 S4, plan §2.3 and §2.6): the days nobody has marked, each
 * with a Training / Test pick, and a range mark for a run of them. Every write is the tool's
 * dry run first, shown inline, then one confirm. No modal: no SPA screen uses one.
 *
 * Wall (768 px and up): a list up to 960 px wide, the pick on the right of each row, and the
 * range card pinned at the top. Phone: rows stack, the pick goes full width, and the range card
 * is pinned at the foot with a full-width Confirm.
 */
import React from 'react';
import { useStore } from 'zustand';
import {
  Alert,
  AlertDescription,
  Button,
  Link,
  Radio,
  RadioGroup,
  Spinner,
  Surface,
  Switch,
  Typography,
} from '@titan-design/react-ui';

import { dashboardStore } from '../store.js';
import { routeHash } from '../routing.js';
import { useIsNarrowViewport } from '../use-viewport.js';
import { ButtonLabel } from '../planner/PanelCard.js';
import { PAGE_PADDING } from '../planner/PlanBuilderPage.js';
import { RADIUS, SPACE } from '../planner/design.js';
import { DayRow } from './DayRow.js';
import { DaysAlert, MarkPreviewCard } from './MarkPreviewCard.js';
import { daysInRange, type MarkKind } from './days-model.js';
import { useDaysFlow, type DaysFlow, type SavedMark } from './use-days-flow.js';

const LIST_MAX_WIDTH = 960;
const GOALS_HASH = routeHash({ name: 'goals' });

function Header(props: { flow: DaysFlow }): React.JSX.Element {
  const { flow } = props;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: SPACE.md }}>
      <div style={{ flex: '1 1 auto' }}>
        <Typography variant="h5">Review days</Typography>
      </div>
      <Switch
        isChecked={flow.showAll}
        onCheckedChange={flow.setShowAll}
        label="Show marked days too"
      />
      <Button size="sm" variant="outline" onPress={flow.toggleRange}>
        <ButtonLabel>{flow.rangeMode ? 'Done with range' : 'Mark a range'}</ButtonLabel>
      </Button>
    </div>
  );
}

function SavedNotice(props: { saved: SavedMark }): React.JSX.Element {
  const { result, warning } = props.saved;
  const count = result.newlyClassified.length + result.reclassified.length;
  return (
    <>
      <Alert status="success" testID="days-saved">
        <AlertDescription>
          {`Saved: ${String(count)} ${count === 1 ? 'session' : 'sessions'} marked ${result.kind}`}
        </AlertDescription>
      </Alert>
      {warning !== null && (
        <Alert status="warning" testID="days-rederive-warning">
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

function AllMarked(): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: SPACE.xs, alignItems: 'baseline' }}>
      <Typography variant="subtitle1">Every day is marked</Typography>
      <Link
        href={GOALS_HASH}
        color="primary"
        onPress={() => {
          window.location.hash = GOALS_HASH;
        }}
      >
        Back to goals
      </Link>
    </div>
  );
}

function RangeKindPick(props: { flow: DaysFlow }): React.JSX.Element {
  return (
    <RadioGroup
      value={props.flow.range.kind}
      onChange={(value) => props.flow.pickRangeKind(value as MarkKind)}
      orientation="horizontal"
      aria-label="Mark the range as"
    >
      <Radio value="training">Training</Radio>
      <Radio value="test">Test</Radio>
    </RadioGroup>
  );
}

function rangePrompt(flow: DaysFlow): string {
  const { first, last } = flow.range;
  if (first === null) return 'Tap the first day of the range';
  if (last === null) return `From ${first}: tap the last day`;
  const bounds = first <= last ? [first, last] : [last, first];
  return `${bounds[0] ?? ''} to ${bounds[1] ?? ''}`;
}

/** Previewed, previewing or failed: the card replaces the Preview button until an edit. */
function rangeCardOpen(flow: DaysFlow): boolean {
  return flow.preview !== null || flow.pending !== null || flow.error !== null;
}

function RangeCard(props: { flow: DaysFlow; narrow: boolean }): React.JSX.Element {
  const { flow, narrow } = props;
  // Sticky lives on a plain div: react-native-web's View style has no `sticky` position.
  const pin: React.CSSProperties = narrow ? { bottom: 0 } : { top: 0 };
  return (
    <div style={{ position: 'sticky', zIndex: 1, ...pin }}>
      <Surface
        level="raised"
        testID="range-card"
        style={{ borderRadius: RADIUS.card, padding: SPACE.md }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.sm }}>
          <Typography variant="subtitle1">{rangePrompt(flow)}</Typography>
          <RangeKindPick flow={flow} />
          {flow.selection !== null && rangeCardOpen(flow) ? (
            <PreviewFor flow={flow} narrow={narrow} />
          ) : (
            <Button size="md" isDisabled={flow.selection === null} onPress={flow.previewRange}>
              <ButtonLabel tone="on-solid">Preview</ButtonLabel>
            </Button>
          )}
        </div>
      </Surface>
    </div>
  );
}

function PreviewFor(props: { flow: DaysFlow; narrow: boolean }): React.JSX.Element | null {
  const { flow } = props;
  if (flow.selection === null) return null;
  return (
    <MarkPreviewCard
      selection={flow.selection}
      preview={flow.preview}
      busy={flow.pending !== null}
      error={flow.error}
      fullWidth={props.narrow}
      onConfirm={flow.confirm}
      onFlip={flow.flipMarked}
      onRetry={flow.retry}
    />
  );
}

function DayList(props: { flow: DaysFlow; narrow: boolean }): React.JSX.Element {
  const { flow, narrow } = props;
  const unit = useStore(dashboardStore, (s) => s.displayUnit);
  const days = flow.page?.days ?? [];
  const { first, last } = flow.range;
  const highlighted = new Set(first === null ? [] : daysInRange(days, first, last ?? first));
  const picked = flow.rangeMode || flow.selection?.scope !== 'day' ? null : flow.selection;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SPACE.sm }}>
      {days.map((day) => (
        <DayRow
          key={day.day}
          day={day}
          unit={unit}
          narrow={narrow}
          mode={flow.rangeMode ? 'range' : 'pick'}
          picked={picked?.day === day.day ? picked.kind : null}
          inRange={highlighted.has(day.day)}
          disabled={flow.pending === 'mark'}
          onPick={(kind) => flow.pickDay(day.day, kind)}
          onTap={() => flow.tapRow(day.day)}
        >
          {picked?.day === day.day && <PreviewFor flow={flow} narrow={narrow} />}
        </DayRow>
      ))}
    </div>
  );
}

function Body(props: { flow: DaysFlow; narrow: boolean }): React.JSX.Element {
  const { flow, narrow } = props;
  if (flow.page === null) {
    if (flow.readError !== null) return <DaysAlert error={flow.readError} onRetry={flow.reload} />;
    return <Spinner />;
  }
  return (
    <>
      {flow.readError !== null && <DaysAlert error={flow.readError} onRetry={flow.reload} />}
      {flow.saved !== null && <SavedNotice saved={flow.saved} />}
      {flow.page.unreviewedDays === 0 && <AllMarked />}
      {flow.rangeMode && !narrow && <RangeCard flow={flow} narrow={narrow} />}
      <DayList flow={flow} narrow={narrow} />
      {flow.rangeMode && narrow && <RangeCard flow={flow} narrow={narrow} />}
    </>
  );
}

export function DaysPage(): React.JSX.Element {
  const flow = useDaysFlow();
  const narrow = useIsNarrowViewport();
  return (
    <Surface level="base" style={{ minHeight: '100%', padding: PAGE_PADDING }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: SPACE.md,
          width: '100%',
          maxWidth: LIST_MAX_WIDTH,
        }}
      >
        <Header flow={flow} />
        <Body flow={flow} narrow={narrow} />
      </div>
    </Surface>
  );
}
