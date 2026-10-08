/**
 * The review-days flow as pure data (VW-847 S3): what a selection posts, the expected count a
 * range must carry, when a preview is stale, which action id a post uses, the words the preview
 * and the result use, and what an error leads to. No React, no fetch, no clock.
 */
import type { ReviewDay } from '../../../analytics/session-review.js';
import { ActionRefusedError, IndeterminateWriteError } from '../api-client.js';

export type MarkKind = 'training' | 'test';

/** `flowStep` values the posts carry; a rehearsal is always a `*preview` step. */
export type DaysFlowStep = 'preview' | 'mark' | 'range_preview' | 'range_mark';

/** The slice of `session.mark_kind`'s result the screen reads. */
export interface MarkResult {
  kind: MarkKind;
  dryRun: boolean;
  newlyClassified: readonly string[];
  reclassified: readonly string[];
  skippedAlreadyMarked: readonly string[];
  alreadyThisKind: readonly string[];
  setsChanged: number;
  days: readonly string[];
  rederiveFailed: readonly string[];
}

/** One day, or a range whose bounds are days the owner read in the list. */
export type Selection =
  | { scope: 'day'; day: string; kind: MarkKind; reclassify: boolean }
  | { scope: 'range'; from: string; to: string; kind: MarkKind };

/** `days-<suffix>`: one id for every post of a visit. */
export function newFlowId(suffix: string): string {
  return `days-${suffix}`;
}

/**
 * The tool's matched count: all four disjoint lists. Not `newlyClassified` alone, which would
 * make a range holding an already-marked session fail its own guard.
 */
export function expectSessions(
  result: Pick<
    MarkResult,
    'newlyClassified' | 'reclassified' | 'skippedAlreadyMarked' | 'alreadyThisKind'
  >,
): number {
  return (
    result.newlyClassified.length +
    result.reclassified.length +
    result.skippedAlreadyMarked.length +
    result.alreadyThisKind.length
  );
}

/** The two bounds in calendar order, whichever was tapped first. */
export function rangeBounds(a: string, b: string): { from: string; to: string } {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** The listed days between the bounds, inclusive: the rows to highlight. */
export function daysInRange(days: readonly ReviewDay[], from: string, to: string): string[] {
  const bounds = rangeBounds(from, to);
  return days.map((d) => d.day).filter((d) => d >= bounds.from && d <= bounds.to);
}

/** Which flow step a post of this selection carries. */
export function flowStepOf(selection: Selection, phase: 'preview' | 'mark'): DaysFlowStep {
  if (selection.scope === 'day') return phase;
  return phase === 'preview' ? 'range_preview' : 'range_mark';
}

/**
 * The tool input. Never a session id; never `reclassify` on a range; a range mark carries the
 * count the preview returned and a preview carries none.
 */
export function markInput(
  selection: Selection,
  phase: 'preview' | 'mark',
  expected?: number,
): Record<string, unknown> {
  const dryRun = phase === 'preview' ? { dryRun: true } : {};
  if (selection.scope === 'day') {
    return {
      kind: selection.kind,
      day: selection.day,
      ...(selection.reclassify ? { reclassify: true } : {}),
      ...dryRun,
    };
  }
  return {
    kind: selection.kind,
    from: selection.from,
    to: selection.to,
    ...(phase === 'preview' ? dryRun : { expectSessions: expected }),
  };
}

function selectionKey(selection: Selection): string {
  return JSON.stringify(selection);
}

/**
 * Holds the one preview that may be confirmed. Any change to the selection stales it, so a
 * confirm can only follow a preview of exactly what is selected.
 */
export interface PreviewGate {
  record(selection: Selection, result: MarkResult): void;
  clear(): void;
  /** The result the selection was previewed with, or null when none or stale. */
  previewFor(selection: Selection): MarkResult | null;
  canConfirm(selection: Selection): boolean;
}

export function createPreviewGate(): PreviewGate {
  let held: { key: string; result: MarkResult } | null = null;
  const previewFor = (selection: Selection): MarkResult | null =>
    held?.key === selectionKey(selection) ? held.result : null;
  return {
    record(selection, result) {
      held = { key: selectionKey(selection), result };
    },
    clear() {
      held = null;
    },
    previewFor,
    canConfirm: (selection) => previewFor(selection) !== null,
  };
}

/**
 * One action id per step attempt. `idFor` returns the held id while the input is unchanged
 * (Retry) and mints a new one when it differs (an edit), because the server refuses the same
 * id with other input.
 */
export interface AttemptIds {
  idFor(step: DaysFlowStep, input: unknown): string;
}

export function createAttemptIds(mint: () => string): AttemptIds {
  const held = new Map<DaysFlowStep, { key: string; id: string }>();
  return {
    idFor(step, input) {
      const key = JSON.stringify(input);
      const current = held.get(step);
      if (current?.key === key) return current.id;
      const id = mint();
      held.set(step, { key, id });
      return id;
    },
  };
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** The lines the preview card shows before any confirm. */
export function previewLines(result: MarkResult): string[] {
  const lines = [
    `Mark ${plural(result.newlyClassified.length, 'session', 'sessions')} on ${plural(
      result.days.length,
      'day',
      'days',
    )} as ${result.kind}`,
    `${plural(result.setsChanged, 'set', 'sets')} change`,
  ];
  if (result.reclassified.length > 0) {
    lines.push(`${plural(result.reclassified.length, 'session', 'sessions')} will be flipped`);
  }
  if (result.skippedAlreadyMarked.length > 0) {
    lines.push(
      `${String(result.skippedAlreadyMarked.length)} already marked ${otherKind(
        result.kind,
      )} stay as they are`,
    );
  }
  if (result.alreadyThisKind.length > 0) {
    lines.push(`${String(result.alreadyThisKind.length)} already ${result.kind}`);
  }
  lines.push(result.days.join(', '));
  return lines;
}

function otherKind(kind: MarkKind): MarkKind {
  return kind === 'training' ? 'test' : 'training';
}

/** The warning after a saved mark whose baselines did not refresh, or null when all did. */
export function rederiveWarning(result: Pick<MarkResult, 'rederiveFailed'>): string | null {
  if (result.rederiveFailed.length === 0) return null;
  return `Saved. The baselines for ${result.rederiveFailed.join(', ')} were not refreshed`;
}

export type DaysError =
  | { kind: 'invalid_input'; message: string }
  | { kind: 'range_changed' }
  | { kind: 'not_found' }
  | { kind: 'refused'; code: string }
  | { kind: 'indeterminate' }
  | { kind: 'not_saved' };

/** Map what a post threw to the state the screen shows; the selection stays either way. */
export function daysErrorOf(err: unknown): DaysError {
  if (err instanceof ActionRefusedError) {
    if (err.code === 'invalid_input') return { kind: 'invalid_input', message: err.message };
    if (err.code === 'EXPECTED_SESSIONS_MISMATCH') return { kind: 'range_changed' };
    if (err.code === 'NOT_FOUND') return { kind: 'not_found' };
    return { kind: 'refused', code: err.code };
  }
  if (err instanceof IndeterminateWriteError) return { kind: 'indeterminate' };
  return { kind: 'not_saved' };
}

/** What the screen does next. Never `mark`: a confirm is always the owner's tap. */
export type FollowUp = 'preview' | 'refetch' | 'none';

export function followUpOf(error: DaysError): FollowUp {
  if (error.kind === 'range_changed') return 'preview';
  if (error.kind === 'not_found' || error.kind === 'indeterminate') return 'refetch';
  return 'none';
}

/** The words for an error. */
export function errorCopy(error: DaysError): string {
  switch (error.kind) {
    case 'invalid_input':
      return error.message;
    case 'range_changed':
      return 'The range changed since the preview';
    case 'not_found':
      return 'That day is no longer there';
    case 'refused':
      return `Refused: ${error.code}`;
    case 'indeterminate':
      return 'Not sure it saved; showing what is stored';
    case 'not_saved':
      return 'Not saved: the dashboard server did not answer';
  }
}
