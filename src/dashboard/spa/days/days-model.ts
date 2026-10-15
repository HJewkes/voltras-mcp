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
 * The tool input. Never a session id; never `reclassify` on a range; a range is sent in calendar
 * order. A mark must carry the count its fresh preview returned, so it cannot be built without one.
 */
export function markInput(selection: Selection, phase: 'preview'): Record<string, unknown>;
export function markInput(
  selection: Selection,
  phase: 'mark',
  expected: number,
): Record<string, unknown>;
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
    ...rangeBounds(selection.from, selection.to),
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
  /** Drops the held preview; a confirm needs a fresh one. */
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
 * (Retry after a transport failure or an indeterminate result) and mints a new one when it
 * differs (an edit), because the server refuses the same id with other input.
 */
export interface AttemptIds {
  idFor(step: DaysFlowStep, input: unknown): string;
  /**
   * End the attempt at `step`: the next `idFor` mints. Called once a post has a settled outcome
   * (success or a tool refusal), because the server stores that outcome under the id and would
   * replay it, a stale dry run or a refusal, for a repeat of the same input.
   */
  forget(step: DaysFlowStep): void;
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
    forget(step) {
      held.delete(step);
    },
  };
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** The lines the preview card shows before any confirm. */
export function previewLines(result: MarkResult): string[] {
  const newly = result.newlyClassified.length;
  const lines = [
    newly === 0
      ? `No new sessions to mark as ${result.kind}`
      : `Mark ${plural(newly, 'session', 'sessions')} on ${plural(
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
    const skipped = result.skippedAlreadyMarked.length;
    lines.push(
      `${String(skipped)} already marked ${otherKind(result.kind)} ${
        skipped === 1 ? 'stays' : 'stay'
      } as ${skipped === 1 ? 'it is' : 'they are'}`,
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

/**
 * The warning after a saved mark whose baselines did not refresh, or null when all did.
 * `rederiveFailed` holds exercise ids, so they are named from the listed days; an id no listed
 * day carries is counted rather than shown raw.
 */
export function rederiveWarning(
  result: Pick<MarkResult, 'rederiveFailed'>,
  days: readonly ReviewDay[],
): string | null {
  if (result.rederiveFailed.length === 0) return null;
  const names = new Map<string, string>();
  for (const day of days) {
    for (const ex of day.exercises) {
      if (ex.exerciseId !== undefined) names.set(ex.exerciseId, ex.name);
    }
  }
  const known = result.rederiveFailed.flatMap((id) => names.get(id) ?? []);
  const unknown = result.rederiveFailed.length - known.length;
  const parts = [
    ...known,
    ...(unknown > 0 ? [plural(unknown, 'other exercise', 'other exercises')] : []),
  ];
  return `Saved. The baselines for ${parts.join(', ')} were not refreshed`;
}

export type DaysError =
  | { kind: 'invalid_input'; message: string }
  | { kind: 'range_changed' }
  | { kind: 'not_found' }
  | { kind: 'refused'; code: string }
  | { kind: 'indeterminate' }
  | { kind: 'not_saved' }
  | { kind: 'read_failed' };

const INVALID_INPUT_CODES: ReadonlySet<string> = new Set(['invalid_input', 'INVALID_INPUT']);

/** The route sends a handler refusal's text in `result.message`, and the code when it has none. */
function refusalText(err: ActionRefusedError): string {
  const result = err.result as { message?: unknown } | null | undefined;
  if (typeof result?.message === 'string') return result.message;
  return err.message === err.code ? 'That selection was not accepted' : err.message;
}

/** Map what a post threw to the state the screen shows; the selection stays either way. */
export function daysErrorOf(err: unknown): DaysError {
  if (err instanceof ActionRefusedError) {
    if (err.status >= 500) return { kind: 'not_saved' };
    if (INVALID_INPUT_CODES.has(err.code)) {
      return { kind: 'invalid_input', message: refusalText(err) };
    }
    if (err.code === 'EXPECTED_SESSIONS_MISMATCH') return { kind: 'range_changed' };
    if (err.code === 'NOT_FOUND') return { kind: 'not_found' };
    return { kind: 'refused', code: err.code };
  }
  if (err instanceof IndeterminateWriteError) return { kind: 'indeterminate' };
  return { kind: 'not_saved' };
}

/** A failed read of the day list: nothing was being saved, so it never reads "Not saved". */
export function daysReadErrorOf(): DaysError {
  return { kind: 'read_failed' };
}

/**
 * What a failed post does to the attempt. A tool refusal is a stored, completed outcome, so the
 * step's id is forgotten and a repeat mints a new one. A mismatch, a missing day or an unknown
 * outcome also drop the held preview: the owner must see a fresh one before any confirm.
 * A transport failure changes neither, so Retry keeps its id.
 */
export function settleFailure(
  err: unknown,
  step: DaysFlowStep,
  ids: AttemptIds,
  gate: PreviewGate,
): void {
  if (err instanceof ActionRefusedError) ids.forget(step);
  const kind = daysErrorOf(err).kind;
  if (kind === 'range_changed' || kind === 'not_found' || kind === 'indeterminate') gate.clear();
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
      return `The dashboard refused that (${error.code})`;
    case 'indeterminate':
      return 'Not sure it saved; showing what is stored';
    case 'not_saved':
      return 'Not saved: the dashboard server did not answer';
    case 'read_failed':
      return 'Could not load the days: the dashboard server did not answer';
  }
}
