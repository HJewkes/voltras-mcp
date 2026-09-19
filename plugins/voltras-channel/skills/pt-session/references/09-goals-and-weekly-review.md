# Goals and the weekly review

**When to read this.** The user wants to set, check, change or end a goal; OR it is Sunday and the review is due; OR a tool returned `recalibrationOffers`, `realignment`, a `proposal`, or a goal error code; OR the user asks "am I on track?"

The goal system has one shape. **The human says what matters. The coach derives the numbers from history. The human accepts. After that the numbers never move.** Your job is to carry words in, read numbers out, and record answers. You never supply a number. The one exception is the attendance count, which is the lifter's own commitment.

Verified 2026-09-19 against voltras-mcp main (#449 to #458, #463, #470, #473).

## Tool inventory

| Tool                                                                                              | What it does                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal.declare_priorities {items, horizonWeeks?, blockId?}`                                        | Store what the lifter wants to emphasise. `items[]` is `{kind: muscle \| lift, ref, level: specialize \| maintain \| deprioritize, declineFatLossDowngrade?}`. **Takes no target value.** Returns `priorities`, `warnings`, `proposals`, `dietPhase`, `tierUsed`, `thresholds`, `block` |
| `goal.propose_targets {priorityId}`                                                               | Derive a band for every metric that priority is tracked by and store each as a proposal. **Every input is read, none is typed.** Returns `targets`, `context`, `skipped`, `selections`, `horizonWeeks`, `notes`, `recalibrationOffers`                                                  |
| `goal.accept_target {targetId, committedValue?, stretchValue?, acknowledgeStretch?, anchorLoad?}` | Fix one proposal's numbers. Omit both values for the coach default                                                                                                                                                                                                                      |
| `goal.list {includeRetired?}`                                                                     | Every priority with its targets. A target with no `acceptedBy` is an unanswered proposal                                                                                                                                                                                                |
| `goal.retire {priorityId \| targetId, outcome: met \| missed \| abandoned}`                       | End a priority (cascades to its targets) or one target. Also the way to decline a proposal or a recalibration offer                                                                                                                                                                     |
| `goal.new_chapter {targetId, at?}`                                                                | Mark where a target's comparable series restarts after a technique reform. The numbers do not move                                                                                                                                                                                      |
| `goal.weekly_review {weekOf?, response?}`                                                         | The Sunday bodyweight-rate review. Proposes; never edits                                                                                                                                                                                                                                |
| `coaching.explain {topic: "meso.goal_setting"}`                                                   | The sourced prose behind committed and stretch edges. Keep the tier when you relay it                                                                                                                                                                                                   |

## What a priority can name

| The lifter says                               | `kind`   | `ref`                                                                                                                      |
| --------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| "Get my row up"                               | `lift`   | the `exerciseId` from `exercise.search`                                                                                    |
| "Grow my back" / "arms" / "legs"              | `muscle` | a catalog muscle string, or the spoken synonym (`arms` covers biceps and triceps; `legs` covers quads, hamstrings, glutes) |
| "Show up more"                                | `muscle` | `sessions` (a whole-body ref; tracks training days in a rolling 28 days)                                                   |
| "Lose / gain / hold weight"                   | `muscle` | `bodyweight` (whole-body; the band comes from the declared diet phase)                                                     |
| "Get stronger overall"                        | `muscle` | `strength` (a rollup of the specialized lifts; read, never banded on its own)                                              |
| "Get bigger", "body composition", "bar speed" | none     | Not measurable today. `propose_targets` returns the reason; read it out and offer the muscle or `bodyweight` instead       |

One live priority per whole-body ref (`sessions`, `bodyweight`, `strength`). A second one, or the same ref twice in one call, is refused with `GOAL_WHOLE_BODY_PRIORITY_EXISTS` and nothing is written. Re-declare the same ref to change its level. Re-declaring keeps the row, so `mesosHeld` keeps counting across blocks.

## The block a goal binds to

`blockId` defaults to the **upcoming dated block, else the current one**. The result's `block` is `{id, defaulted}`; compare the id with the block you expect and read it back. With no dated block at all, `block` is null and the horizon falls back to a generic 12 weeks with a note that no plan tree backs it.

**So date the block first, then declare.**

Since #473 every target is set for a block (`blockId` on the stored row): the priority's own block when it has dates, else the upcoming dated block, else the current one.

- A target takes that block's **weeks, deloads and end**.
- If the block moves before it starts, the target moves with it. `plan.block.schedule`, `plan.block.update` and an extending `plan.week.skip` list it under `targetsAffected`. **The committed and stretch numbers never move.**
- **Until the block starts, the goals page reads "Starts <date>. No verdict before the block begins."** That is correct, not a fault. Say it that way.
- **Goal weeks are local calendar weeks, Monday to Sunday**, for every goal.
- A deload week, and an off week added by an extend, flatten the band and draw no verdict.

## Flow: declare, propose, accept

```
1. Ask what they want to emphasise, in their words. Ask the level for each.
2. goal.declare_priorities {items}
      → read back block, tierUsed, dietPhase, every warning, every proposal
3. For each priority:
   goal.propose_targets {priorityId}
      → read out start value, BOTH edges, infoLevel, tierProvisional, notes, skipped reasons
4. On the lifter's word, per target:
   goal.accept_target {targetId}                                   # coach default
   goal.accept_target {targetId, committedValue, stretchValue}      # their own numbers, inside the band
   goal.accept_target {…, acknowledgeStretch: true}                 # their own, past the stretch edge
   goal.retire {targetId, outcome: "abandoned"}                     # declined; never re-offered
5. goal.list → read the accepted set back
```

A lifter who wants to **think about it** has not declined. Leave the proposal unanswered. Do not retire it: a retired proposal is never re-offered.

### What to say when you read a proposal out

- **Both edges, always.** "Committed is 182, stretch is 190." The committed value is the band's low edge and the stretch is its high edge. Never present the committed value alone as the forecast.
- **How much evidence is behind it** (`infoLevel`): `cold` is a starting ramp that makes no claim about strength gained; `ramp` is the programmed weekly increment; `own` is this lifter's own fitted trend.
- **A cold lift target carries `startingRamp`** (`sessionsNeeded`, `blockedBy`, `baselineState`, `reProposeAfterCalibration`, `note`). Say: "This is the generic starting ramp, not based on your lifts yet." After acceptance it stays the ramp; a data-based target is offered later, once.
- **`tierUsed` is the DECLARED tier.** A band is sized by what the lifter declared, not by the clamped tier signal. When the two disagree, the target carries `tierProvisional: true`. Say it: "This is sized for intermediate, which you declared. The signal has not confirmed that yet." A band derived under a provisional tier, or with no declared phase (`dietPhaseAtDerivation`), is still fixed once accepted.
- **`skipped[]`**: a metric with no series behind it. Read the reason. Do not route around it.
- **The start value may rest on a bench test.** The owner said most stored sessions were tests, and no tool can mark one yet (VW-489). Ask whether the start value is a real working load before they accept a lift target (`12`).

Since VW-482 (#470), a new lift's ramp is a weekly percent by exercise class and declared tier, with no pound floor, shown at the 1 lb step the device can set. Read the numbers from the tool. Do not recompute them.

### The attendance goal is the one number the lifter states

A `sessions` target is a commitment, not a derived gain. Say how it works before you ask for a number.

- **What the tool offers.** Its only input is the count of training days in the last 28 days. The band is flat by design: committed and stretch are both that count. It reads no intended frequency. The profile's `daysReliable` and the plan's workouts per week do not reach it. With no training day in the last 28, the target is `skipped` and no attendance goal can be set.
- **How an intent is recorded.** The lifter states their own number on acceptance. "Three days a week" is 12 in 28. Above the proposal, the call needs `acknowledgeStretch: true` and is stored as `acknowledgedStretch`, because nothing in the last 28 days supports it. The band is not redrawn to make it look supported. Say that out loud.
- **How it is judged.** On pace. The goals page pro-rates the committed count over the first 28 days after acceptance: "5 of the 6 due by now against a committed 12." It is never a streak, and a missed day is never scored as a failure.
- **You ask; you do not suggest.** Pass their number as `committedValue`, and `stretchValue` as the same number unless they name a higher one. If they ask what is realistic, give facts only.

Training days are distinct local calendar days with an ended session. Twelve exercises logged as twelve sessions on one day count once. A session never ended is not a training day today (VW-489).

### A `reps_at_load` target

Pass `anchorLoad`, the load its reps are counted at, so the goal reads as a whole set ("12 reps at 185 lb"). Ask the lifter which load they mean. Any other metric refuses it (`GOAL_ANCHOR_LOAD_NOT_APPLICABLE`).

## Guardrails: advisory, never blocking

`goal.declare_priorities` stores exactly what was declared. `warnings[]` may carry:

| Code                                     | Meaning                                                      | What to say                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specialize_cap_exceeded`                | More than 2 specialized items                                | "That is more than two things to specialize. It is allowed. Spreading emphasis is how a block ends with no visible gain anywhere. Keep all of them?" |
| `priority_changed_mid_block`             | A priority changed inside its block                          | "Priorities usually hold for the whole block. Change it now, or at the block boundary?"                                                              |
| `priority_persistence_nudge`             | A specialized priority dropped after fewer than 2 mesocycles | "You have held that for one block. Commit to a couple more, or drop it?"                                                                             |
| `fat_loss_specialize_beginner_exception` | Fat loss plus a beginner tier                                | Read it as written: a beginner's program does not change across diet phases                                                                          |

`proposals[]` carries the **fat-loss downgrade offer** (specialize to maintain). Relay it and wait. Accept: declare the item again at `maintain`. Decline: declare it again with `declineFatLossDowngrade: true`; it is never offered again for that ref. **Never apply it yourself.**

## After acceptance: the fixed-target rule

- A second `goal.accept_target` returns `GOAL_TARGET_FIXED`.
- You may not raise a target the lifter is beating. That is a block-boundary decision.
- You may not lower one they are missing.
- `GOAL_TARGET_BELOW_BAND`: a value short of the committed edge is refused.
- `GOAL_TARGET_ABOVE_BAND`: a value past the stretch edge needs `acknowledgeStretch: true`. The band itself is never moved to make it look supported.
- `GOAL_TARGET_RETIRED`: the target was already retired.

The honest exits:

| Situation                                              | Call                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The goal ended: met, missed, or dropped                | `goal.retire {targetId \| priorityId, outcome}`. Ask the lifter for the outcome. Retiring a priority cascades; its targets default to `abandoned`. Nothing is deleted        |
| The movement itself changed (new grip, reformed depth) | `goal.new_chapter {targetId, at?}`. The lifter says so; you never infer it from a drop. Undo with `exercise.retire_chapter`. Refused for a target with no exercise behind it |

## Reading progress

The read model gives each target a status: `on_track`, `ahead`, `behind`, `stalled`, `goal_met`, `beyond_goal`, `tolerated`, `deload_week`, or `calibrating`. These come from the dashboard's goals page (`server.health.dashboardUrl`, then `#/goals`) and from `goal.weekly_review` for bodyweight. No MCP tool returns the full per-target progress view; point the user at the page for the chart and say only what your tools returned.

Things worth knowing when you talk about status:

- A lift is `stalled` only for a flatline: a run the plateau detector calls flat **and** whose slope is under a quarter of the programmed weekly step. A lifter climbing slowly reads `behind`, not stalled. A wobbling lift needs 21 days to read flat; one repeated load needs 14.
- `tolerated` means the declared diet phase explains the flat run.
- A band is anchored where the goal started, on week 1 of its block. It does not follow the lifter.
- `goal_met` and `beyond_goal` stick for the rest of the block.
- A maintenance or hold bodyweight goal reads `behind` when the weight leaves its corridor, on either side (`corridorSide`: `above` or `below`). The advice for any bodyweight goal that is behind names intake and activity, not load and reps.
- An accepted bodyweight goal with no recent weigh-in stays on the page and says so.
- `metrics.compute {pipeline: "history.trend", exerciseId, metric}` gives the raw trend and `plateau.verdict` (`plateau`, `tolerated`, `none`).

## Recalibration offers (VW-444)

`goal.propose_targets` and `goal.weekly_review` both return `recalibrationOffers`: every accepted starting ramp whose lift has since calibrated, each with a data-based target inside the ramp's own block (same start, end and weeks; only the numbers change), as the proposal row `offerTargetId`.

- **Raise it once.** "Your row has calibrated. Your goal is still the starting ramp. A target based on your own lifts is ready: committed X, stretch Y. Take it, or keep the ramp?"
- Accept: `goal.accept_target {targetId: offerTargetId}`. It retires the ramp it replaces and returns `recalibration`.
- Decline: `goal.retire {targetId: offerTargetId, outcome: "abandoned"}`. Returns `declinedOffer: true`. Not offered again in that block.
- `GOAL_RECALIBRATION_WITHDRAWN`: the lift is no longer calibrated. The ramp stays. Say so.
- Retiring the starting ramp itself withdraws its open offer.

## The block-boundary re-ask

On the last workout of a block, `plan.complete_workout` returns `blockBoundary`; on the first workout of a new block, `plan.next_workout` does; and `plan.block.planning_brief` carries the same read when a block is finishing. With declared priorities it carries `realignment`: each priority, how many mesocycles it has been held, the bands it would get for the next block, and `warningsIfChanged`. Offer the three answers: **keep, restate, re-architect.** Nothing is written. An accepted target comes back under `skipped`: the re-ask re-proposes and never silently lowers a committed number.

## The Sunday review: `goal.weekly_review`

```
profile.log_bodyweight {…}                 # today's reading, COPIED from the health log, if there is one
profile.log_weekly_checkin {…}             # hunger is the lever-choice input
goal.weekly_review                         # weekOf defaults to the most recent Sunday
report.weekly                              # training days, planned vs done
```

It returns `observation` (observed percent per week, the band, how far off the line, which way the gap is moving), `advisory`, `levers`, `vetoes`, `offCadenceConditions`, `confounders`, `lowConfidence`, `checkin`, `readingCount`, `targetId`, `committedValue`, `stretchValue`, `committedUnchanged`, `outcome`, `proposal`, `suppressedByDecline`, `reviewedAt`, `notes`, `recalibrationOffers`.

How to relay it:

1. **The observation, as read.** "You moved minus 0.4 percent this week against a band of minus 0.5 to minus 1."
2. **A veto, by name.** Four exist: `settling`, `noise_floor`, `spike_in_window`, `salt_and_sweetener_creep`. Each carries its own `reason`. Read the reason. Do not add your own suggestion on top of a veto. Plain words for each are in `10`.
3. **The advisory is never sized.** It names two levers, **intake and activity**, and says the pick is the lifter's. You prescribe no calories, no macros, no step counts. The health system sizes intake.
4. **Sleep is a confounder line only.** Read it beside the observation. It never triggers a change.
5. **A proposal gets an answer.** Ask, then `goal.weekly_review {weekOf, response: "accepted" | "declined" | "ignored"}`. A declined proposal is never raised again for the same week at the same urgency.
6. **Nothing on the chart moves.** Committed and stretch are read, never written. The diet phase is never written here. If they want a phase change, that is `profile.set_diet_phase`, on their word.

A slow-loss recomposition is judged against its own band (hold to minus 0.5 percent a week): a flat week reads on track, a gaining week reads behind.

With few readings, `lowConfidence` is set. Say so. Two weeks of weigh-ins is about the least that supports a rate.

## Pitfalls

- **Declaring before the diet phase is set.** The bodyweight band then defaults to the maintenance corridor, and acceptance fixes it.
- **Declaring before the block is dated.** The goal binds to no block and runs a generic 12 weeks.
- **Proposing bodyweight with no reading in 30 days, or sessions with no training day in 28.** Both come back `skipped`. Log or train first.
- **Reading only the committed number.** Always both edges.
- **Suggesting the attendance number.** It is theirs.
- **Retiring a proposal the lifter only wanted to postpone.** It is never re-offered.
- **Reading "Starts <date>" as a broken goal.** The block has not begun.
- **Saying a lowered tier shrank the band.** It set `tierProvisional`; the size came from the declared tier.
- **Offering a recalibration twice.**
- **Guest sets.** They never feed the owner's goals.
- **Sessions never ended.** They are not training days today (VW-489), so the attendance count undershoots. End every session.
- **Bench tests in the history.** Ask before a start value built on one is accepted.

## Cross-refs

- Weigh-ins, the diet phase, the weekly check-in, the vetoes in plain words: `10-bodyweight-diet-phase-rate-advisory.md`
- Block dates, `targetsAffected`, the planning sitting: `11-dated-blocks-and-planning-sitting.md`
- The declared and the clamped tier: `12-onboarding-gaps-and-tier-signal.md`
- The Sunday script and its attendance script: `14-sittings.md`
