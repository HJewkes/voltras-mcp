/**
 * The `#/days` screen's state and transitions (VW-847 S4). Every transition is an explicit call
 * from a handler, never an effect watching state: a refusal, a mismatch and a Retry each say
 * what runs next, so nothing waits on a re-render to fire. The rules themselves (ids, the
 * preview gate, error mapping) are `days-model`'s; this only sequences them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { createMutationLatch, MIN_LATCH_HOLD_MS } from '../planner/mutation-latch.js';
import type { SessionReviewPage } from '../../session-review-api.js';
import { fetchSessionReview, postMarkKind } from './days-client.js';
import {
  createAttemptIds,
  createPreviewGate,
  daysErrorOf,
  daysReadErrorOf,
  followUpOf,
  newFlowId,
  rangeBounds,
  rederiveWarning,
  type DaysError,
  type MarkKind,
  type MarkResult,
  type Selection,
} from './days-model.js';

type Phase = 'preview' | 'mark';

/** Tapped range bounds, in tap order; either may be unset while selecting. */
export interface RangeDraft {
  first: string | null;
  last: string | null;
  kind: MarkKind | null;
}

/** The outcome of the last confirmed mark, shown until the next selection. */
export interface SavedMark {
  result: MarkResult;
  warning: string | null;
}

export interface DaysFlow {
  page: SessionReviewPage | null;
  readError: DaysError | null;
  showAll: boolean;
  rangeMode: boolean;
  range: RangeDraft;
  selection: Selection | null;
  /** The fresh preview of `selection`, or null when none or stale. */
  preview: MarkResult | null;
  pending: Phase | null;
  error: DaysError | null;
  saved: SavedMark | null;
  setShowAll(showAll: boolean): void;
  reload(): void;
  pickDay(day: string, kind: MarkKind): void;
  flipMarked(): void;
  toggleRange(): void;
  tapRow(day: string): void;
  pickRangeKind(kind: MarkKind): void;
  previewRange(): void;
  confirm(): void;
  retry(): void;
}

const EMPTY_RANGE: RangeDraft = { first: null, last: null, kind: null };

const sameSelection = (a: Selection | null, b: Selection | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** The range a draft names, once both bounds and a kind are picked. */
export function rangeSelection(draft: RangeDraft): Selection | null {
  if (draft.first === null || draft.last === null || draft.kind === null) return null;
  return { scope: 'range', ...rangeBounds(draft.first, draft.last), kind: draft.kind };
}

/** A tap sets the first bound, then the last; a third tap starts over from the tapped day. */
export function nextRangeDraft(draft: RangeDraft, day: string): RangeDraft {
  if (draft.first === null || draft.last !== null) return { ...draft, first: day, last: null };
  return { ...draft, last: day };
}

function mintId(): string {
  return crypto.randomUUID();
}

/** One visit's id machinery: the flow id, the attempt ids and the preview gate. */
function useVisit() {
  const ref = useRef<{
    flowId: string;
    ids: ReturnType<typeof createAttemptIds>;
    gate: ReturnType<typeof createPreviewGate>;
  } | null>(null);
  ref.current ??= {
    flowId: newFlowId(mintId().slice(0, 8)),
    ids: createAttemptIds(mintId),
    gate: createPreviewGate(),
  };
  return ref.current;
}

/** The day list: read once on mount, then only on an explicit call (a toggle, a mark, Retry). */
function useDayList() {
  const [page, setPage] = useState<SessionReviewPage | null>(null);
  const [readError, setReadError] = useState<DaysError | null>(null);
  const [showAll, setShowAllState] = useState(false);
  const showAllRef = useRef(showAll);
  const load = useCallback(async (all = showAllRef.current): Promise<void> => {
    try {
      setPage(await fetchSessionReview(all ? 'any' : 'unreviewed'));
      setReadError(null);
    } catch {
      setReadError(daysReadErrorOf());
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const setShowAll = (all: boolean): void => {
    showAllRef.current = all;
    setShowAllState(all);
    void load(all);
  };
  return { page, readError, showAll, setShowAll, load };
}

export function useDaysFlow(): DaysFlow {
  const visit = useVisit();
  const list = useDayList();
  const [daySelection, setDaySelection] = useState<Selection | null>(null);
  const [rangeMode, setRangeMode] = useState(false);
  const [range, setRange] = useState<RangeDraft>(EMPTY_RANGE);
  const [pending, setPending] = useState<Phase | null>(null);
  const [error, setError] = useState<DaysError | null>(null);
  const [failed, setFailed] = useState<Phase | null>(null);
  const [saved, setSaved] = useState<SavedMark | null>(null);
  const [, setGateVersion] = useState(0);
  const current = useRef<Selection | null>(null);
  const latch = useRef(createMutationLatch({ minHoldMs: MIN_LATCH_HOLD_MS })).current;

  const selection = rangeMode ? rangeSelection(range) : daySelection;
  current.current = selection;

  const post = async (sel: Selection, phase: Phase, keep: DaysError | null = null) => {
    setPending(phase);
    setError(keep);
    setFailed(null);
    try {
      const result = await postMarkKind({ selection: sel, phase, ...visit });
      if (phase === 'mark') await afterMark(result);
    } catch (err) {
      if (sameSelection(sel, current.current)) await afterFailure(sel, phase, err);
    } finally {
      setPending(null);
      setGateVersion((v) => v + 1);
    }
  };

  const afterMark = async (result: MarkResult): Promise<void> => {
    setSaved({ result, warning: rederiveWarning(result, list.page?.days ?? []) });
    setDaySelection(null);
    setRange(EMPTY_RANGE);
    setRangeMode(false);
    await list.load();
  };

  /** A mismatch re-previews under a new id and keeps its alert; a confirm stays the owner's tap. */
  const afterFailure = async (sel: Selection, phase: Phase, err: unknown): Promise<void> => {
    const daysError = daysErrorOf(err);
    setError(daysError);
    setFailed(phase);
    const next = followUpOf(daysError);
    if (next === 'refetch') await list.load();
    if (next === 'preview') await post(sel, 'preview', daysError);
  };

  const select = (sel: Selection): void => {
    setSaved(null);
    current.current = sel;
    void post(sel, 'preview');
  };

  return {
    ...list,
    reload: () => void list.load(),
    rangeMode,
    range,
    selection,
    preview: selection === null ? null : visit.gate.previewFor(selection),
    pending,
    error,
    saved,
    pickDay(day, kind) {
      const sel: Selection = { scope: 'day', day, kind, reclassify: false };
      setDaySelection(sel);
      select(sel);
    },
    flipMarked() {
      if (daySelection?.scope !== 'day') return;
      const sel: Selection = { ...daySelection, reclassify: true };
      setDaySelection(sel);
      select(sel);
    },
    toggleRange() {
      setRangeMode(!rangeMode);
      setRange(EMPTY_RANGE);
      setDaySelection(null);
      setError(null);
    },
    tapRow(day) {
      setRange(nextRangeDraft(range, day));
      setError(null);
    },
    pickRangeKind(kind) {
      setRange({ ...range, kind });
      setError(null);
    },
    previewRange() {
      if (selection !== null) select(selection);
    },
    confirm() {
      if (selection === null || !visit.gate.canConfirm(selection)) return;
      void latch.run(() => post(selection, 'mark'));
    },
    retry() {
      if (selection === null) return;
      const phase = failed === 'mark' && visit.gate.canConfirm(selection) ? 'mark' : 'preview';
      void latch.run(() => post(selection, phase));
    },
  };
}
