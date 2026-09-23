# Analytics and coaching

**When to read this.** A set just ended and you need to compute metrics; OR the session is wrapping up; OR the user asks "how am I doing?"; OR you are about to quote a velocity, an estimated 1RM, a readiness zone, a plateau or a "baseline" and need to know how much to trust it.

Coaching is the visible layer. Analytics is the data layer. Every derived claim comes with a **qualifier** you must relay: a confidence, a basis, a band, a note, a tier. And one thing you never claim at all without a trusted fitted profile: **effort** (`13`).

## Tool inventory

| Tool                                                                               | What it does                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics.compute {pipeline, …}`                                                    | One dispatch tool; `pipeline` picks the analytics function. 18 pipelines below (the tool's own description still says 17). Readouts, never recommendations, never applied                                                                         |
| `report.session_results {sessionId}`                                               | One ended session as per-exercise result strings a coach reads (`170 lb x 12`, `L 30 lb x 13` / `R 30 lb x 12`), plus warm-up counts and a `missed:` line when a rep band was attached. Working sets only; guest, mock and zero-rep sets excluded |
| `report.weekly {from?, to?, format?, lifter?, notes?}`                             | A coach-readable weekly summary, markdown or JSON, default the last 7 days                                                                                                                                                                        |
| `set.get {setId}`                                                                  | A persisted set with every rep. Post-hoc review                                                                                                                                                                                                   |
| `session.get {id}`                                                                 | A session with all its sets. Large; browse with `session.list` first. Carries `sessionPace` when a plan is attached: an estimate from the plan, never a measurement                                                                               |
| `session.list {from?, to?, exerciseId?, lifter?, sort?, limit?, offset?, detail?}` | Summary rows by default. `detail: "full"` adds every set and rep and can exceed 100 KB a session                                                                                                                                                  |
| `progression.get_for_exercise {exerciseId, …}`                                     | Top weight and volume across recent sessions, with `comparability`. See `03`                                                                                                                                                                      |
| `baselines.get {exerciseId, side?, setupId?}`                                      | The confidence **state** of the exercise baseline. A diagnostic. Never values                                                                                                                                                                     |
| `baselines.recalc {exerciseId, side?, setupId?, reharvest?, inferSetups?}`         | Force a recalculation. Only for old history or after a threshold change                                                                                                                                                                           |
| `rir_velocity.fit` / `rir_velocity.target`                                         | The lifter's own RIR-velocity curve. See `13`                                                                                                                                                                                                     |
| `coaching.explain {topic, tier?, exerciseId?, rir?}`                               | Sourced prose with citations. Topics below                                                                                                                                                                                                        |
| `driftguard.check` / `mrvguard.check`                                              | Diagnostics: "why did the system refuse to compare these sessions" and "did two consecutive sessions underperform." Not coaching answers                                                                                                          |

## `metrics.compute` pipelines

| Pipeline                | Input                                        | Returns                                                                                                                                             | Relay with                                                                                                                                                          |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vbt.set`               | `{setId}`                                    | first/last/best/mean/peak velocity, `lossPct` (mean-based), `repCount`                                                                              | For the set that just ended, `set_ended.vbt_summary` already has it                                                                                                 |
| `vbt.profile`           | `{setIds: [≥2], targetVelocity?}`            | A load-velocity fit; with `targetVelocity`, a recommended load and confidence, or null when the fit is flat                                         | Null is an answer. Never fill it                                                                                                                                    |
| `vbt.rir`               | `{setId, targetReps?}`                       | Per-rep reps in reserve with `basis` and three confidence axes                                                                                      | **See `13`. A `profile-estimate` is not a proximity-to-failure read.** Its loss is peak-based and will not equal `vbt.set`'s                                        |
| `fatigue.verdict`       | `{setId}`                                    | The wall's own verdict: `state` (`good`, `slowing`, `grinding`, `form-breakdown`), `tone`, and per-dimension tones for velocity loss, ROM and tempo | A ROM or tempo alarm overrides a clean velocity read into `form-breakdown`. Null below 2 reps. **Prefer this**                                                      |
| `fatigue.set`           | `{setId}`                                    | A within-set fatigue index                                                                                                                          | Deprecated upstream. Use `fatigue.verdict`                                                                                                                          |
| `quality.rep`           | `{setId, baselineSetId}`                     | Per-rep quality against a real prior set                                                                                                            | Session 1 has no baseline set; say so                                                                                                                               |
| `quality.rom`           | `{setId}`                                    | Range-of-motion integrity: per-rep ROM against the set's own median, first-to-last decay, consistency                                               | Within-set and baseline-free. `baseline.note` says why a cross-session number was refused                                                                           |
| `quality.hesitation`    | `{setId}`                                    | Per-rep velocity troughs inside the concentric                                                                                                      | `hesitated` is always null. Relay the raw crossings, not a verdict. Post-set only                                                                                   |
| `quality.bounce`        | `{setId}`                                    | Turnaround dwell times and the eccentric-to-concentric peak ratio                                                                                   | `bounce` and `diveBomb` are always null. Raw numbers only. Post-set only                                                                                            |
| `session.volume`        | `{sessionId}`                                | `{tonnageLbs, setsByMuscle, model: "target-only"}`                                                                                                  | Each working set counts toward its exercise's PRIMARY muscle only. A chest press is one chest set, zero shoulders                                                   |
| `session.fatigue`       | `{sessionId}`                                | Cross-set fatigue for the session's exercise, plus `fatigueAxes`                                                                                    | Read `coaching.explain {topic: "live.fatigue_axes"}` before interpreting either axis                                                                                |
| `session.strength`      | `{sessionId}`                                | A session strength estimate with `comparability`                                                                                                    | Say whether the rest of the session was like-for-like with the top set                                                                                              |
| `session.readiness`     | `{sessionId, baselineSessionId, probeLoad?}` | Probe velocity against a prior session, `zoneVerdict`, `dietPhaseContext`                                                                           | **Always `basis: "heuristic"` with a `note`. Relay the note.** Never present the zone as measured. `zoneVerdict: "tolerated"` means the diet phase explains the dip |
| `session.perturbation`  | `{sessionId, exerciseId?}`                   | First-versus-last working set decay, and `fatigueAxes` (`entryDepression`, `lateSessionDecay`)                                                      | Report the ratios. `interpretation` stays null until a cited threshold exists                                                                                       |
| `session.junk_volume`   | `{sessionId, exerciseId?}`                   | Per-set mean and peak loss side by side, and a retrospective                                                                                        | `movementClassKnown` is always false: not valid for ballistic pulls. Relay that                                                                                     |
| `strength.e1rm`         | `{load, reps}` or `{exerciseId}` or both     | An estimated 1RM with `band`, `mvtBasis`, `isPR`, `priorBest`                                                                                       | **A trend instrument, never a measurement.** `band.fitFor` is always `trend`. A session-to-session change inside the band is noise. Never move load on one session  |
| `history.trend`         | `{exerciseId, weeks?, metric?, …}`           | Weekly series, raw trend fit, `plateau`                                                                                                             | `direction` is always null; read `slope`, `rSquared`, `percentChange`. `plateau.verdict` is `plateau`, `tolerated` or `none`                                        |
| `history.weekly_volume` | `{weeks?}`                                   | Weekly totals and a per-muscle breakdown                                                                                                            | `verdict` is always null. No volume landmark is invented                                                                                                            |

Session pipelines other than `session.volume` scope to the session's own exercise by each set's `exerciseId`. Unlabelled sets are invisible to them.

Every number here is a ratio or a count. A missing target id returns `NOT_FOUND` before any analytics runs.

### Plateau and estimated 1RM: what the words mean

- A lift reads `plateau` only for a **flatline**: a run the detector calls flat AND whose slope is under a quarter of the programmed weekly step. A lifter climbing slowly is not a plateau. A wobbling lift needs 21 days to read flat; one repeated load needs 14.
- `tolerated` means the declared diet phase explains a run that short. Say that, not "stalled".
- A declared new chapter clamps the window. Lead with the reframe, never with the pre-chapter number to beat.
- `mvtBasis: "default"` on an e1RM is not an error. Say the estimate rests on a population threshold, not this lifter.

## Baselines and gates

`baselines.get` tells you how much the server knows, not what it knows:

- `baseline: null`: this (exercise, side) has never been recalculated. Not the same as `COLD`.
- `COLD` / `SHAPE_ONLY` / `PROVISIONAL`: observed, not yet trustworthy. Present derived numbers as provisional.
- `CALIBRATED`: derived numbers may be stated with normal confidence.
- `STALE`: the algorithm version moved; `baselines.recalc` refreshes it.

Baselines recalculate on every `set.end` for the set's exercise and side. They read the owner's `working` sets only: warm-ups, probes, technique sets and **guest sets are excluded**. `anchorSelection.pooledFallback: true` means you asked for one setup and the exercise-wide anchors answered instead; say so. Hand a baseline number to the user tier-qualified, or not at all.

`baselines.recalc {reharvest: true}` labels failures that already happened. It never asks anyone to train to failure, and a harvested anchor is a measurement: no praise, no count. `inferSetups: true` returns neutral labels ("setup 1"). Ask the user what a setup is and record their answer with `exercise.confirm_setup`. Never offer a guess to confirm.

**Remember the history may be bench tests** (`12`). A baseline or a trend may rest on test pulls. Ask before you lean on it.

Two other baselines you pick by hand:

- **`baselineSetId`** for `quality.rep`: a clean prior set of the same exercise. Find it with `session.list {exerciseId, limit: 5}` then `set.get`.
- **`baselineSessionId`** for `session.readiness`: the most recent prior session of the same exercise.

## `coaching.explain` topics

`onboarding.*`: `tier_inference`, `frequency_negotiation`, `goal_commitment_alignment`, `injury_intake`.
`live.*`: `cue_budget`, `cue_delivery`, `warmup_protocol`, `rir_estimation`, `stop_set_signal`, `velocity_loss_threshold`, `readiness_interpretation`, `eccentric_overload_cost`, `fatigue_axes`.
`meso.*`: `deload_trigger`, `deload_ladder`, `volume_progression`, `post_deload_restart`, `exercise_rotation`, `e1rm_interpretation`, `asymmetry_interpretation`, `diet_phase_tolerance`, `goal_setting`.
`diet.*`: `phase_coupling`, `phase_durations`, `disruption_handling`, `rate_autoregulation`.

Every response states tier-specific values inline. **Never strip the tier.** Pass `tier` to narrow; omit it when the tier is not known. `caveats` flags a topic whose sources contradict each other; quote a range, not one number. The `diet.*` topics explain; they do not license you to size intake (`10`).

## The weekly report

`report.weekly` renders markdown or JSON from one data tree, so the numbers always agree. Sections are omitted when empty:

- A header: `trainingDaysCompleted` in the range and `rolling28DayTrainingDays`. **Both count training days**: distinct local dates trained, however many sessions a day holds. Never a streak. Plus adherence `planned N / done M` against the active program's touched weeks, and a coarse trend against the previous range.
- One block per session: date, template, `preSessionCarbs` when reported, the `report.session_results` strings, and an RIR line **only when its gate allows**, labelled `fitted` or `general model, not a proximity-to-failure read`. Relay the label with the line.
- One progression line per exercise, labelled "suggestion for the coach, not applied".
- Flags: weight mismatches, sets closed by inactivity with reps recorded, velocity-loss holds. `setting_coerced` is never listed; it is live-only.
- A check-in section from recorded self-reports.

Remember the test-session caveat when you read the day counts out (`12`).

## Coaching style

**Concise.** 2 to 4 sentences between sets. 3 to 5 lines at the end.

**Specific.**

| Vague                    | Specific                                                  |
| ------------------------ | --------------------------------------------------------- |
| "You slowed down a bit." | "Velocity dropped 18% from your fastest rep to the last." |
| "That looked tough."     | "Last rep was 0.41 m/s against 0.73 on rep 2."            |
| "ROM was inconsistent."  | "Rep 3 was 8 cm short on the concentric."                 |

**Decisive.** One next action. "Same load, one more set."

**Budgeted.** 1 to 2 cues before the set, at most 1 to 2 reminders of the same cue during it, 1 to 2 points after. Detecting more faults does not buy more cues. Advanced lifters get silence in-set.

**Tier-qualified.** Keep the tier and the caveats on anything from `coaching.explain`.

**Honest about gaps.** No setup instructions in the catalog. Say so when asked.

## Coaching by phase

### Mid-set

Default: quiet. Speak only on `set_target_reached` ("That's eight. Let go when you're done."), a `velocity_loss_exceeded` ("Twenty-five percent down."), or an explicit question. If automatic cues are on (`server.health.cues`), the server already speaks these; do not double them. Every spoken line mutes the mic while it plays, so say little (`08`).

### Between sets

From `set_ended.vbt_summary`, plus `metrics.compute {pipeline: "fatigue.verdict"}` when you want the wall's own call:

1. What happened: "Twelve reps at 70. Seven percent velocity loss."
2. What the instruments say: "The fatigue read is good: velocity, range and tempo all held."
3. What next: "Up five."
4. Optional: "Two more, then triceps."

**Step 2 never names an RPE or reps in reserve.** The installed skill's example ("that's two or three in reserve") is withdrawn: the evidence does not support reading effort off velocity loss, and the wall now shows a dash in the same place. If the lifter tells you how many they had left, you may repeat it as theirs.

### End of session

```
session.end {slot, checkin?}
plan.complete_workout {workoutTemplateId, sessionId}                              # if on a program
report.session_results {sessionId}
metrics.compute {pipeline: "session.volume", sessionId}
metrics.compute {pipeline: "session.fatigue", sessionId}
metrics.compute {pipeline: "session.readiness", sessionId, baselineSessionId}   # if one exists; relay its note
plan.suggest_progression {exerciseId}                                            # per exercise on a program
```

Then: total volume vs last time, fatigue trajectory, what improved (rep counts and loss percentages), what to focus on next session. On a bilateral rig there are two sessions; compute per session and say which side.

## What NOT to do

- **Don't state an RPE or reps in reserve** from velocity loss or a general model (`13`).
- **Don't quote a number without its qualifier.** Basis, band, confidence, baseline state, tier, note.
- **Don't fabricate telemetry.** `{active: false}` means no set.
- **Don't move load on an e1RM**, and don't read an asymmetry as a reason for single-limb work.
- **Don't promise quality flags or readiness on session 1.**
- **Don't relay diagnostics as advice.** `baselines.get`, `driftguard.check`, `mrvguard.check`.
- **Don't invent a verdict where the tool returns null.** `direction`, `hesitated`, `bounce`, `interpretation` and the weekly-volume `verdict` are null on purpose.
- **Don't drown the user.** If you are listing five metrics you have lost them.

## Cross-refs

- The set whose data you are reading: `04-set-execution.md`
- What you may claim about effort: `13-effort-rir-and-failure-sets.md`
- `vbt_summary` and `rep_finalized` payloads: `08-channel-events-reference.md`
- Progression suggestions and the warm-up ramp: `03-workout-programming.md`
- Goals and progress status words: `09-goals-and-weekly-review.md`
- Rest, where coaching lands: `05-rest-periods.md`
