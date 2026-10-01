// Cue focus identity and in-session persistence for the cue-delivery layer (VW-140 plan 3.4).
//
// One technique focus per exercise at a time. A set pins the exercise's focus when it
// starts, so pre, intra and post all read the same id. The focus persists across sets
// until a set reads clean for it, then earns a reinforcement line for a fixed number of
// sets. Cross-session persistence is a later slice.

/** Every focus id, in the fixed order that picks one when several faults read at once. */
export const CUE_FOCUS_IDS = ['full_range', 'control_lowering', 'smooth_drive'] as const;

export type CueFocusId = (typeof CUE_FOCUS_IDS)[number];

/** Sets whose post-set debrief reinforces a focus after it reads clean. */
export const REINFORCEMENT_SETS = 3;

interface ExerciseFocus {
  current: CueFocusId | null;
  reinforcing: CueFocusId | null;
  reinforceSetsLeft: number;
}

interface SetFocus {
  exerciseId: string;
  focusId: CueFocusId | null;
  reinforcement: CueFocusId | null;
}

export interface FocusState {
  readonly exercises: ReadonlyMap<string, ExerciseFocus>;
  readonly sets: ReadonlyMap<string, SetFocus>;
}

export const EMPTY_FOCUS_STATE: FocusState = { exercises: new Map(), sets: new Map() };

const NO_FOCUS: ExerciseFocus = { current: null, reinforcing: null, reinforceSetsLeft: 0 };

export interface SetStart {
  exerciseId: string;
  setId: string;
}

export interface SetOutcome {
  setId: string;
  /** Focus ids the set's detectors read as faults; order does not matter. */
  faults: readonly CueFocusId[];
  reinforcementSets?: number;
}

/** Pin the exercise's current focus to a new set; the first set of an exercise has none. */
export function beginSet(state: FocusState, start: SetStart): FocusState {
  const focusId = (state.exercises.get(start.exerciseId) ?? NO_FOCUS).current;
  const pinned: SetFocus = { exerciseId: start.exerciseId, focusId, reinforcement: null };
  return { exercises: state.exercises, sets: new Map(state.sets).set(start.setId, pinned) };
}

/** The set's focus, identical in every interval of the set; `null` for an unknown set. */
export function focusForSet(state: FocusState, setId: string): CueFocusId | null {
  return state.sets.get(setId)?.focusId ?? null;
}

/** The resolved focus this set's post-set debrief reinforces, or `null`. */
export function reinforcementForSet(state: FocusState, setId: string): CueFocusId | null {
  return state.sets.get(setId)?.reinforcement ?? null;
}

/** Fold one finished set's faults into its exercise's focus; never mutates the input. */
export function recordSetOutcome(state: FocusState, outcome: SetOutcome): FocusState {
  const pinned = state.sets.get(outcome.setId);
  if (pinned === undefined) return state;
  const previous = state.exercises.get(pinned.exerciseId) ?? NO_FOCUS;
  const { next, reinforcement } = advance(previous, outcome);
  return {
    exercises: new Map(state.exercises).set(pinned.exerciseId, next),
    sets: new Map(state.sets).set(outcome.setId, { ...pinned, reinforcement }),
  };
}

function advance(
  previous: ExerciseFocus,
  outcome: SetOutcome,
): { next: ExerciseFocus; reinforcement: CueFocusId | null } {
  const faults = new Set(outcome.faults);
  let { current, reinforcing, reinforceSetsLeft } = previous;
  if (current !== null && !faults.has(current)) {
    reinforcing = current;
    reinforceSetsLeft = outcome.reinforcementSets ?? REINFORCEMENT_SETS;
    current = null;
  } else if (reinforcing !== null && faults.has(reinforcing)) {
    reinforcing = null;
    reinforceSetsLeft = 0;
  }
  current ??= CUE_FOCUS_IDS.find((id) => faults.has(id)) ?? null;
  const reinforcement = reinforceSetsLeft > 0 ? reinforcing : null;
  reinforceSetsLeft = Math.max(0, reinforceSetsLeft - 1);
  if (reinforceSetsLeft === 0) reinforcing = null;
  return { next: { current, reinforcing, reinforceSetsLeft }, reinforcement };
}
