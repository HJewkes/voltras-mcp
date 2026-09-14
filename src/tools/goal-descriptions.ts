// Tool descriptions for the `goal.*` namespace (VW-350).
//
// Split out of `goal-tools.ts` for the reason the descriptions are long: each
// one has to carry the rule a caller cannot infer from the schema — that the
// coach picks the metric, that a start value is read and never typed, that an
// accepted target does not move, and that the band a caller displays is never
// shaded to match what the lifter agreed to.

export const GOAL_DECLARE_PRIORITIES_DESCRIPTION =
  'Record what the lifter wants to emphasise this block: `items` of ' +
  '`{kind: muscle|lift, ref, level: specialize|maintain|deprioritize}`, plus an optional ' +
  '`horizonWeeks` and `blockId`. NO TARGET VALUE IS TAKEN HERE — the human states priorities and ' +
  'the coach derives the numbers (`goal.propose_targets`). `ref` is a catalog muscle string or a ' +
  'spoken synonym ("arms", "legs") for a muscle, and an exerciseId for a lift; anything not listed ' +
  'stays `maintain` by default. Re-declaring a priority keeps its row, so `mesosHeld` keeps ' +
  'counting across blocks. Returns `priorities` (the stored rows), `warnings`, `proposals`, ' +
  '`dietPhase`, `tierUsed` and `thresholds`. EVERY GUARDRAIL IS ADVISORY AND NOTHING IS BLOCKED: ' +
  'the declaration is stored exactly as made. `warnings` may carry `specialize_cap_exceeded` (more ' +
  'than 2 specialized items — a reading of the corpus, not a stated rule), ' +
  '`priority_changed_mid_block` (rp:rp-s6-priority-muscle-held-constant-per-block), ' +
  '`priority_persistence_nudge` (a specialized priority dropped after fewer than 2 mesocycles, ' +
  'rp:rp-s5-goal-persistence-multi-meso) and `fat_loss_specialize_beginner_exception`. ' +
  '`proposals` carries the fat-loss downgrade OFFER (`specialize` to `maintain`, ' +
  'rp:rp-s5-fatloss-priority-training-rule): relay it, never apply it. Accept it by declaring the ' +
  'item again at `maintain`; decline it by declaring again with `declineFatLossDowngrade: true`, ' +
  'which is recorded and never re-offered for that ref.';

export const GOAL_PROPOSE_TARGETS_DESCRIPTION =
  'Derive the coach’s expected band for every metric one priority is tracked by, and store ' +
  'each as a PROPOSAL (`acceptedBy` absent) for the lifter to accept. Takes only `priorityId`: ' +
  'EVERY INPUT IS READ, NONE IS TYPED — the start value comes from history (top load at matched ' +
  'reps for a lift, the recent bodyweight mean, the rolling 28-day session count), the tier from ' +
  'the tier signal, the phase from the declared diet phase, the weeks from the plan tree. Returns ' +
  '`targets` (each with `targetId`, `metric`, `exerciseId`, `anchorReps`, `startValue`, ' +
  '`startMeasuredAt`, `matchedSessionCount`, `bandLowPctPerWeek`, `bandHighPctPerWeek`, ' +
  '`committedValue`, `stretchValue`, `basis`, `infoLevel`, `tierUsed`, `tierProvisional`, ' +
  '`dietPhaseAtDerivation`, `provisional`, `rpIds` and `notes`), plus `context` (read-only legs ' +
  'such as the e1RM trend, banded but never stored or scored), `skipped` (a metric with no series ' +
  'behind it, carrying the reason), `selections` (the full metric rule output, including the ' +
  'weekly-sets DOSE and any corroboration gap), `horizonWeeks` and `notes`. COMMITTED IS THE ' +
  'BAND’S LOW EDGE AND STRETCH IS ITS HIGH EDGE (rp:rp-s10-underpromise-overdeliver-goal-setting): ' +
  'show both, and never present the committed value alone as the forecast — the displayed ' +
  'projection is never shaded (B55). `infoLevel` says how much the evidence earned: `cold` is an ' +
  'execution ramp with no gain claim, `ramp` is the programmed increment, `own` is this lifter’s ' +
  'own fitted slope. A metric whose proposal was declined is never re-offered.';

export const GOAL_ACCEPT_TARGET_DESCRIPTION =
  'Fix one proposed target’s numbers. Omit `committedValue` and `stretchValue` to take the ' +
  'coach default (`acceptedBy: coach-default`); supply either to set the lifter’s own ' +
  '(`acceptedBy: user`). ONCE ACCEPTED THE NUMBERS NEVER MOVE: a second call returns ' +
  '`GOAL_TARGET_FIXED`, the coach may not raise a target the lifter is beating (that is a ' +
  'block-boundary decision) and may not lower one they are missing. The exits are `goal.retire` ' +
  'with an outcome and `goal.new_chapter`. A value short of the committed edge is refused ' +
  '(`GOAL_TARGET_BELOW_BAND`): that edge is already the conservative one ' +
  '(rp:rp-s10-underpromise-overdeliver-goal-setting). A value past the stretch edge needs ' +
  '`acknowledgeStretch: true` and is then recorded as `acknowledgedStretch` — THE BAND ITSELF IS ' +
  'NEVER MOVED to make it look supported (B55). Returns `target`, `acceptedBy`, ' +
  '`acknowledgedStretch`, `bandUnchanged`, `rpIds` and `note`.';

export const GOAL_LIST_DESCRIPTION =
  'READ-ONLY. Every declared priority with the targets derived under it, newest declaration ' +
  'first. Returns `priorities`, each `{priority, targets}`. A target with no `acceptedBy` is a ' +
  'proposal the lifter has not answered yet, and its numbers may still be re-derived; one with an ' +
  '`acceptedBy` is fixed. Pass `includeRetired: true` to include retired priorities and targets — ' +
  'a retired target keeps its `outcome`, because what was attempted is part of the record.';

export const GOAL_RETIRE_DESCRIPTION =
  'End one priority (`priorityId`) or one target (`targetId`) with the `outcome` it ended on: ' +
  '`met`, `missed` or `abandoned`. Pass exactly one id. RETIRING A PRIORITY CASCADES to every ' +
  'live target under it, in one transaction; the targets are MARKED, never deleted, because a ' +
  'band the lifter worked toward is a fact about what was attempted. A cascade defaults its ' +
  'targets to `abandoned` — the honest outcome for a target whose priority went away — and an ' +
  'explicit `met` or `missed` restamps them. This is also the decline path for a proposal: ' +
  'retiring an unaccepted target as `abandoned` means it is never re-proposed. Returns ' +
  '`priority`, `targets` and `cascaded`.';

export const GOAL_NEW_CHAPTER_DESCRIPTION =
  'Stamp `newChapterAt` on a target whose movement itself changed — a technique reform (squat ' +
  'depth, a grip change) that makes the stored `startValue` a measurement of a different ' +
  'exercise. THE TARGET’S NUMBERS DO NOT MOVE: this is not a way around the fixed-target rule, ' +
  'it records where the comparable series restarts so the read model shows a new chapter instead ' +
  'of a drop. Pass `at` to stamp a past instant; omitted means now. Returns `target` and `note`.';
