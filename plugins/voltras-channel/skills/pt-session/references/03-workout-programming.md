# Workout programming — programs, templates, next workout, progression

**When to read this.** The user mentions a program, plan, mesocycle, or "the workout I did last time"; OR a session is starting and you want to offer "continue your program" vs "one-off"; OR `plan.next_workout` returned something other than a template; OR a session is ending and you want to suggest progression; OR you are building plan rows.

If the user just says "let's lift," run a clean labelled session without `plan.*`, and offer to file it against a program at the end. Labelling the session with an exercise is not optional either way; that lives in `04-set-execution.md`.

Onboarding and the tier signal moved to `12-onboarding-gaps-and-tier-signal.md`. Block dates, missed weeks and the planning sitting are in `11-dated-blocks-and-planning-sitting.md`.

## Mental model of a plan

```
program
  └─ block        (mesocycle, e.g. "Block 2 — Orientation", weeksCount: 2; may carry real dates)
      └─ week     (orderIndex 0..N; isDeload, phaseType, weekIndex)
          └─ workoutTemplate   (e.g. "Upper A", orderIndex 0..N)
              └─ plannedExercise
                    targetSets, targetRepsLow/High, targetWeightLbs, targetRpe, restSec,
                    trainingIntent, targetTempo, exerciseId
```

Sessions and sets are stored independently. A **ProgramAssignment** row, written by `plan.attach_to_session` or `plan.complete_workout`, links a session to a planned exercise or a whole template. A template is "done" when any assignment points at it.

`targetRpe` on a planned exercise is a prescription the plan's author wrote. It is not a reading. You still state no RPE for a set the lifter performed (`13`).

## Tool inventory

| Tool                                                                                                                                                                                                                                      | What it does                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan.program.create {name, description?}` / `.list {includeArchived?}` / `.get {id}` / `.archive {id}`                                                                                                                                   | Program CRUD. Archived programs never count as the plan in force                                                                                                                                                 |
| `plan.block.create {programId, orderIndex, name, weeksCount, focus?, notes?, startsOn?, scaffoldWeeks?, deloadWeeks?, reason?}` / `.list_for_program {programId}`                                                                         | Blocks. `startsOn` is a local Monday. Dates, moves and resizes are in `11`                                                                                                                                       |
| `plan.week.create {blockId, orderIndex, name?, phaseType?, isDeload?, weekIndex?}` / `.list_for_block {blockId}` / `plan.week.update`                                                                                                     | Weeks. `phaseType` is the PRESCRIBED phase (free text). It is a different claim from the observed diet phase (`10`)                                                                                              |
| `plan.template.create {weekId, name, orderIndex, dayLabel?, notes?}` / `.get {id}` / `.list_for_week {weekId}`                                                                                                                            | Templates                                                                                                                                                                                                        |
| `plan.exercise.create {workoutTemplateId, exerciseId, orderIndex, targetSets, targetRepsLow?, targetRepsHigh?, targetWeightLbs?, targetRpe?, restSec?, notes?, targetTempo?, trainingIntent?}` / `.list_for_template {workoutTemplateId}` | Planned exercises. `exerciseId` is a catalog id from `exercise.search`. `trainingIntent` (`strength`, `hypertrophy`, `power`) feeds the velocity-loss watch threshold and the default rest. Returns `warnings[]` |
| `plan.current_block`                                                                                                                                                                                                                      | Which block is in force today, and whether planning is due (`11`)                                                                                                                                                |
| `plan.next_workout {programId?}`                                                                                                                                                                                                          | The next un-completed template, or one of two other shapes (below)                                                                                                                                               |
| `plan.attach_to_session {sessionId, plannedExerciseId XOR workoutTemplateId}`                                                                                                                                                             | Link a session to a plan entity. Idempotent                                                                                                                                                                      |
| `plan.complete_workout {workoutTemplateId, sessionId?}`                                                                                                                                                                                   | Mark a template done. Returns `current`, and `blockBoundary` on the last workout of a block. Pass `sessionId` explicitly                                                                                         |
| `plan.suggest_progression {exerciseId, programId?, completedSessionId?, lifter?}`                                                                                                                                                         | A load or rep suggestion with `reasoning`, `gates`, `tier` and `dietPhaseContext`. Advisory; present it, never auto-apply                                                                                        |
| `plan.warmup_ramp {exerciseId, workingWeightLbs, slot?}`                                                                                                                                                                                  | A proposed warm-up ramp. Reads only; you start each rung yourself                                                                                                                                                |
| `progression.get_for_exercise {exerciseId, limit?, lookbackWeeks?, lifter?, side?}`                                                                                                                                                       | "What did I hit last time": top weight and volume across the last 20 sessions / 8 weeks, with `comparability`                                                                                                    |
| `truecoach.import_week {from?, to?, programId?, dryRun?, mapping?, refresh?}`                                                                                                                                                             | Pulls the owner's coach-assigned week into the plan tree. A by-hand read of the user's own data. **Never present it as a sanctioned integration.** Run `dryRun: true` first                                      |
| `coaching.explain {topic, tier?}`                                                                                                                                                                                                         | Sourced prose by topic (`onboarding.*`, `live.*`, `meso.*`, `diet.*`) with tier-split values inline                                                                                                              |

## `plan.next_workout`: three shapes

With `programId`, that program is walked in order. Without it, the plan in force decides: in a current dated block only that block is walked; with no dated block, the newest program with workouts left is walked.

| Shape                                                               | Say and do                                                                                                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{template, plannedExercises, block, week, …}`                      | Run it                                                                                                                                                                          |
| `{ok: true, completed: true}`                                       | Every workout in scope is done. Offer to plan what comes next                                                                                                                   |
| `{ok: true, unplanned: true, state, reason, endedBlock, nextBlock}` | "There is no planned workout today. Training continues unplanned." **Never present a workout from the ended block.** When `nextBlock` is null, offer to plan the next block now |

Every shape carries `planning`. When `planning.due`, follow `planning.prompt`: ask about planning the next block, and create nothing until they answer.

`blockBoundary` is null unless the template is the first of a new block. Then it carries the finished block, the new block, the goal on file, `realignment` (the priorities re-ask, once priorities exist) and `recompReAsk`. Relay both. Nothing is written or applied (`09`, `10`).

## Building plan rows: warnings are suggestions

`plan.exercise.create` re-checks tier-aware volume ceilings over the whole template after each insert, plus three checks across the week. Each warning is a **suggestion**. The write always succeeds; a warning never blocks, rolls back or edits the row. Read it out, offer the fix it names, and drop it after a decline. Never re-apply it.

`plan.block.create` with an existing block's `id` updates it in place. If that raises `weeksCount` after weeks were built, `warnings[]` carries `meso_length_grew_mid_block`. Advisory.

Confirm before writing rows; programs accumulate.

## Best-practice flows

### Flow A — continue an existing program

```
plan.next_workout
    → a template, or completed, or unplanned (above); read planning
exercise.get {id: plannedExercises[0].exerciseId}
plan.warmup_ramp {exerciseId, workingWeightLbs: targetWeightLbs}     # offer the ramp
bilateral.cascade {mode: "WeightTraining", weightLbs, eccentricOverloadLbs: 0, chainsLbs: 0}
device.get_state per slot
session.start {exerciseId: plannedExercises[0].exerciseId, slot}     # per slot you will record on
plan.attach_to_session {sessionId, workoutTemplateId: template.id}   # or plannedExerciseId for one exercise
(set loop; session.set_exercise {exerciseId, slot} before each new planned exercise)
session.end {slot, checkin?}
plan.complete_workout {workoutTemplateId: template.id, sessionId}
    → read current; relay blockBoundary if present
report.session_results {sessionId}
```

### Flow B — one-off, filed retroactively

```
(run a clean labelled session)
plan.program.list → show the user
plan.template.list_for_week (walk program → block → week if needed)
plan.complete_workout {workoutTemplateId, sessionId}      # whole template
  or plan.attach_to_session {sessionId, plannedExerciseId} # one exercise
```

Both work after `session.end` too, as long as you pass `sessionId`.

### Flow C — build a new program in conversation

```
plan.program.create {name: "Voltra Return"}                          → P
plan.block.create {programId: P, orderIndex: 0, name: "Block 1", weeksCount: 4,
                   startsOn: "<a Monday>", scaffoldWeeks: true}      → B and its week rows
plan.template.create {weekId: W, orderIndex: 0, name: "Day A — Push", dayLabel: "Mon"}   → T
plan.exercise.create {workoutTemplateId: T, exerciseId, orderIndex: 0, targetSets: 4, targetRepsLow: 6,
                      targetRepsHigh: 8, targetWeightLbs: 55, restSec: 120, trainingIntent: "strength"}
    → read warnings[] out
```

Build week 1 fully, run it, then copy forward. Date blocks ahead of when they start (`11`).

### Flow D — pure one-off

No `plan.*` at all. Still `session.start {exerciseId}` and `session.set_exercise` on every change.

## The warm-up ramp

`plan.warmup_ramp` returns rows and writes nothing. You start each row yourself with `set.start {setPurpose: "warmup"}`. You may skip or shorten it if the lifter says they are already warm.

- The shape: 12 reps, then 8, then 4, at rising loads, before the FIRST exercise for a muscle group. For a later exercise on a muscle that is already warm, one 3 to 6 rep feel set (`feelSetOnly: true`, with `reason`).
- **The loads are a population estimate, not personal.** They assume the working load is about a 5RM: roughly 58, 70 and 88 percent of it. That reads light on purpose. If the lifter says a rung felt too easy or too heavy, believe them.
- The tier changes only the number of rungs. The signal cannot report `advanced` yet, so you will see 3 or 4 rungs.
- **Run the last rung.** The heaviest rung is what `session.readiness` reads its probe velocity from.
- Each row carries its own coaching focus. Use it instead of "warming up".

## How `plan.suggest_progression` decides

It reads the most recent session for the exercise (or `completedSessionId`), keeps only `working` sets, and scores them against the planned rep band. It returns `delta` (lb), `repDelta`, `reasoning`, `gates` and `dietPhaseContext`.

| Condition                                                           | Suggestion | Why                                                  |
| ------------------------------------------------------------------- | ---------- | ---------------------------------------------------- |
| Most sets hit `targetRepsHigh` and no set lost 25% or more velocity | **+5 lb**  | The band was cleared at a sustainable speed          |
| Most sets hit `targetRepsHigh` but some set lost 25% or more        | **hold**   | The reps came near failure; adding load compounds it |
| Most sets missed `targetRepsLow`                                    | **-5 lb**  | Back off                                             |
| Neither majority                                                    | **hold**   | In band                                              |
| No completed sets                                                   | **-5 lb**  | The session bailed                                   |
| No rep band on the plan, or no prior session                        | **hold**   | Nothing to learn from                                |

"Most" is a strict majority; ties hold. Above about a 15-rep prescription the rep is the finer dial, so the suggestion adds a rep (`repDelta`) instead of weight.

`gates` reports three ordered gates: `technique` (`stable`, `unstable`, `unknown`), `effort` (`hard`, `easy`, `unknown`), and `setsUnlocked`. Technique is read from the working sets' own range-of-motion integrity. `unknown` never holds the load: an unproven technique is not a failed one. Every hold says in words which reading caused it. On a `pull` exercise, `effort` reads `unknown` and the velocity hold never applies.

Three things it never does:

- **An estimated 1RM never moves load here.** An e1RM is a trend read. See `metrics.compute` `history.trend` with `metric: "e1rm"`.
- **An asymmetry never prescribes single-limb work.** No gate reads a left/right difference or an isometric maximum.
- **It is never applied for you.** Offer it; record the answer; do not re-offer a declined one.

**The declared diet phase moves the line.** Fat loss widens the rep shortfall tolerated before a back-off, more with each week in phase. Gain tightens it. When the phase changed the answer, `reasoning` says so in a clause. **Relay that clause, never the bare delta.** A named guest always reads an unknown phase.

## `progression.get_for_exercise`: read the comparability first

- `comparability` names the most recent earlier session whose top set is like-for-like with the latest one. When it reports `noValidComparison`, say what changed (`nearest.reasons`). Do not present the trend delta as progress.
- `sideSplit.setupComparability: "setup_confounded"` means the two arms moved the cable different distances. **Do not read the left/right load gap as an imbalance.** Relay `setupReason`. `setup_unverified` means the check never ran.
- `setupCard: "setup_card_mismatch"` means the declared setup changed. Say which field; do not call the load difference a training effect.
- `sideSplit.comparisonMetric` names which figure to compare between sides: `peak_force` when both recorded it, else `top_weight`.
- `chapterStartedAt` non-null means the lifter declared a new chapter. The window is clamped to it, and the pre-chapter loads are not the number to beat. A clamped window with zero sessions is a new chapter with nothing recorded since, not an untrained exercise.
- Without `lifter`, every read is owner-only.

## Plan attachment with warm-ups and a second lifter

Attachment is per session, at template or planned-exercise granularity. There is no way to attach only some sets. `setPurpose` on ramp and probe sets is what keeps the scoring honest. A guest's sets are labelled with `session.set_lifter` (see `04-set-execution.md`) and never count toward the owner's scoring, so they may share the slot's session.

## Pitfalls

- **`next_workout` has three shapes.** Check for `unplanned` and `completed` before you read `template`.
- **Presenting a workout from an ended block.**
- **`attach_to_session` is XOR.** One of `plannedExerciseId` / `workoutTemplateId`, never both or neither.
- **`complete_workout` on a bilateral rig with two sessions throws `AMBIGUOUS_SESSION`.** Pass `sessionId`.
- **`exerciseId` is the catalog id.** Look it up. `exerciseName` on `session.start` is the free-text escape hatch, but a name-only `session.set_exercise` into a session that already has an id-attributed exercise is rejected (`AMBIGUOUS_EXERCISE_SWITCH`) unless the name matches the catalog exactly.
- **Don't auto-create programs or blocks.** Confirm first.
- **`progression.get_for_exercise` does not validate `exerciseId`.** A typo returns an empty history, not an error.
- **Relaying a bare "+5".** Relay the reasoning, and the diet-phase clause when there is one.

## Cross-refs

- Block dates, missed weeks, the planning sitting: `11-dated-blocks-and-planning-sitting.md`
- Onboarding gaps and the tier signal: `12-onboarding-gaps-and-tier-signal.md`
- Session labelling, set execution, second lifter: `04-set-execution.md`
- Analytics that inform progression coaching: `06-analytics-and-coaching.md`
- Recovery when a session crashes mid-template: `07-recovery-and-escalation.md`
