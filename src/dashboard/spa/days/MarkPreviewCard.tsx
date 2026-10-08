/**
 * The dry run's consequence and the one confirm (VW-847 S4, plan §2.1). Confirm stays disabled
 * until the tool's own rehearsal of exactly this selection is back, so the owner always reads
 * the counts before anything is written. Every error the flow can reach has its words here.
 */
import React from 'react';
import { Alert, AlertDescription, Button, Spinner, Typography } from '@titan-design/react-ui';

import { ButtonLabel } from '../planner/PanelCard.js';
import { SPACE } from '../planner/design.js';
import {
  errorCopy,
  previewLines,
  type DaysError,
  type MarkResult,
  type Selection,
} from './days-model.js';

const ALERT_STATUS: Record<DaysError['kind'], 'warning' | 'error' | 'info'> = {
  invalid_input: 'error',
  range_changed: 'warning',
  not_found: 'info',
  refused: 'error',
  indeterminate: 'warning',
  not_saved: 'error',
  read_failed: 'error',
};

/** The outcomes a Retry can resolve; the rest re-preview or refetch on their own. */
const RETRYABLE: ReadonlySet<DaysError['kind']> = new Set([
  'not_saved',
  'indeterminate',
  'refused',
  'read_failed',
]);

/** An error's words, with Retry where repeating is what the owner would do next. */
export function DaysAlert(props: { error: DaysError; onRetry(): void }): React.JSX.Element {
  const retryable = RETRYABLE.has(props.error.kind);
  return (
    <Alert status={ALERT_STATUS[props.error.kind]} testID="days-alert">
      <AlertDescription>{errorCopy(props.error)}</AlertDescription>
      {retryable && (
        <Button size="sm" variant="outline" onPress={props.onRetry} style={{ marginTop: SPACE.xs }}>
          <ButtonLabel>Retry</ButtonLabel>
        </Button>
      )}
    </Alert>
  );
}

/** Nothing would change: every matched session is already this kind or stays as it is. */
function writesNothing(preview: MarkResult): boolean {
  return preview.newlyClassified.length + preview.reclassified.length === 0;
}

function PreviewBody(props: { preview: MarkResult | null }): React.JSX.Element {
  if (props.preview === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: SPACE.xs }}>
        <Spinner size="sm" />
        <Typography variant="body2" color="secondary">
          Checking what this would change…
        </Typography>
      </div>
    );
  }
  const [headline, ...rest] = previewLines(props.preview);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }} data-testid="mark-preview">
      <Typography variant="subtitle1">{headline}</Typography>
      {rest.map((line) => (
        <Typography key={line} variant="body2" color="secondary">
          {line}
        </Typography>
      ))}
    </div>
  );
}

export interface MarkPreviewCardProps {
  selection: Selection;
  preview: MarkResult | null;
  busy: boolean;
  error: DaysError | null;
  fullWidth: boolean;
  /** Pads the card when it sits under a row; the range card already pads its own content. */
  inset: boolean;
  onConfirm(): void;
  onFlip(): void;
  onRetry(): void;
}

/** A day whose preview leaves sessions of the other kind can flip them, behind its own preview. */
function canFlip(selection: Selection, preview: MarkResult | null): boolean {
  if (selection.scope !== 'day' || selection.reclassify || preview === null) return false;
  return preview.skippedAlreadyMarked.length > 0;
}

function FlipButton(props: { preview: MarkResult; busy: boolean; onFlip(): void }) {
  const count = props.preview.skippedAlreadyMarked.length;
  const other = props.preview.kind === 'training' ? 'test' : 'training';
  return (
    <Button size="sm" variant="ghost" isDisabled={props.busy} onPress={props.onFlip}>
      <ButtonLabel>{`Also flip the ${String(count)} marked ${other}`}</ButtonLabel>
    </Button>
  );
}

export function MarkPreviewCard(props: MarkPreviewCardProps): React.JSX.Element {
  const { preview } = props;
  const confirmable = preview !== null && !props.busy && !writesNothing(preview);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: SPACE.sm,
        padding: props.inset ? SPACE.md : 0,
      }}
      data-testid="mark-preview-card"
    >
      {props.error !== null && <DaysAlert error={props.error} onRetry={props.onRetry} />}
      <PreviewBody preview={preview} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: SPACE.xs }}>
        <Button
          size="md"
          isDisabled={!confirmable}
          fullWidth={props.fullWidth}
          onPress={props.onConfirm}
          aria-label="Confirm mark"
        >
          <ButtonLabel tone="on-solid">Confirm</ButtonLabel>
        </Button>
        {canFlip(props.selection, preview) && preview !== null && (
          <FlipButton preview={preview} busy={props.busy} onFlip={props.onFlip} />
        )}
      </div>
    </div>
  );
}
