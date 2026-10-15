# Sittings

**When to read this.** The user wants the Sunday sitting, first goals, a weekly review, or a planning sitting; OR it is one of the first four signal sittings (S0 to S3) from the gated roadmap (`sources/design/2026-09-19-voltras-gated-roadmap.md`, section 6).

A sitting is a conversation with tool calls. S0 has no device: no scan, no lease, no session. S1 to S3 are real workouts with a short signal block.

The order inside a sitting matters because **an accepted target never moves**. Facts first, then dates, then priorities, then proposals, then acceptance.

Every "expect" below is a rule or a field to read, not a value from an earlier day. Dates come from a named tool result: today from the session clock, the block dates from `plan.block.planning_brief` `suggested`, the unreviewed range from `session.review_list`. If a read differs from what a step says to expect, stop and say what you found.

> **Owner rulings.** Facts the owner has ruled, with the date of each. They are not steps.
>
> - 2026-09-19: "mark everything test for now". It stands for every day except the one in the next ruling.
> - 2026-10-03 (a): 2026-09-07 counts as a training day once the guest sets are relabelled and the day is re-marked. Both are operator steps; the coach never does them. Until then the store shows that day as test. Read `session.review_list`, say so, and do not re-mark it.
> - 2026-10-03 (b): the next undated block starts the first Monday after the first sitting and runs as the re-entry block. Planning for the block after it waits until that block's last week.
> - 2026-10-03 (c): the first sitting covers bodyweight, diet phase, priorities, block dates and the week's commitment.
> - 2026-10-03 (d): the first accountability message is sent only after a commitment exists.
> - 2026-10-03 (e): bodyweight is copied from the health log until a shared record exists.

## Preflight: is the live server on main?

Do this before anything else, in every sitting.

```
server.health                → adapter: "node" (not "mock"); dbPath is the real store
plan.current_block           → the tool must exist
```

`server.health` may report `build: "unknown"`, so the build field proves nothing. Compare the schema or build the server reports, where it reports one, against what this skill needs; where it does not, the test is a tool that exists only on current main. `plan.current_block` is one. If it is missing, the server is older than the dated-block work: no block dates, no planning brief, no `plan.week.skip`.

**If the tool is missing, stop.** Say: "This server cannot date a block. It needs a restart onto current main before we do this." Do not substitute `plan.block.create` without dates. Do not run the rest of the sitting on the old server: goals declared there bind to no block and run a generic 12 weeks, and acceptance fixes that.

A live server can lag the main checkout: the store it opened may be at an older schema than main. If the reported schema or build is older than the tools this sitting calls, the live server has **not** been restarted onto main. Tell the owner the restart order. **You never perform these steps yourself.** They come from the gated roadmap, section 6:

1. Back up the store file to a dated `.bak` file. The roadmap advises testing the migration on a copy first.
2. Update and rebuild the main checkout.
3. Restart the live server. Pending migrations run together on start. Ask the owner to read the migration notes for the row counts they touch.
4. Do not start a bench build from an older branch until it is updated from main. It may expect an older schema than the store now holds.

Then run the preflight again and start the sitting.

---

## S0. The first goals sitting: bodyweight, break length, diet phase, block dates, priorities, the week's commitment

No device. 30 to 40 minutes. Say the plan in one breath first: "Six things: your weight, one question about your last break, your diet phase, dates for the next block, what you want to emphasise, then the numbers. I ask, you decide, I read everything back." Today's date is the session clock's; name it once aloud so the owner can correct it.

### Step 1. Orient (reads only, say little)

```
plan.current_block           → expect state: "undated_only", the program's name, block: null, nextBlock: null,
                               planning.due: true, planning.reason: "No block has dates yet."
goal.list                    → expect no priorities
profile.get_onboarding_gaps  → missing[], lastBreakQuestion, goalRealism, medicalClearanceRequired
profile.get_body_metrics     → expect no readings
profile.get_training_background → the stored answers; read each back, name what is unanswered
```

If any read surprises you (a dated block already exists, priorities already exist, a bodyweight is already logged), stop and tell the owner what you found before you write anything. A store with a dated block is not this sitting: go to the weekly review or the planning sitting.

If `medicalClearanceRequired` is true, read `medicalClearanceNote` as written and go no further into programming.

**Session kinds first, if the server has them.** Call `session.review_list`. If the tool exists, the owner's standing ruling applies (see Owner rulings): "mark everything test for now". So:

1. Read the list back as a count only: "N days are unreviewed. You told me to mark them all as tests for now." Take `from` and `to` from the oldest and newest day on the list, and the day and session counts from the result. Name the one day ruled a training day (ruling a) if it is on the list: "That day shows as test until your operator steps are done." Trust the live reads.
2. Dry run: `session.mark_kind { "kind": "test", "from": "<oldest>", "to": "<newest>", "dryRun": true }`. Read back `newlyClassified`, `reclassified`, `skippedAlreadyMarked` and the day count. Expect `reclassified: 0`.
3. On the owner's "yes", the real call: the same input without `dryRun`, plus `"expectSessions": <the newlyClassified count the dry run gave>`. Without it the tool refuses and names the count; that is one retry, not a fault. Then `session.review_list` should return no unreviewed day. Read `rederiveFailed` in the result: expect it empty. If it names an exercise, the mark is still saved; run `baselines.recalc` and `rir_velocity.fit` for each named exercise and say so.
4. Say once: "Any of those you later tell me was a real workout, I re-mark as training. I never guess." Re-marking one of these days later needs `reclassify: true`, because it is no longer unreviewed.

This ruling is for this sitting's backlog only. At every later sitting, ask about each unreviewed day.

What changes after the marking, so re-read everything below from the tools and trust the tool over this script: training days read what `profile.get_tier_signal` `evidence.trainingDaysLogged` says; the 28-day count is whatever the target's `startValue` reads, and when it is 0 the attendance target comes back `skipped` and no attendance goal can be set today (say so plainly and move on; it is re-proposed once real training days exist); lift proposals have no training history behind them, so expect cold starting values or skips, and read out exactly what `goal.propose_targets` returns; the tier signal stays beginner, provisional, until logged history lifts it. Do not re-mark a day to make a goal possible.

**If `session.review_list` does not exist**, the server predates session kinds. Then ask before you treat past days as training. The owner has said that most stored sessions were bench tests, not training. Every count of "logged training days" is overstated, and any start value may rest on a test pull. Do not call the logged days a training history. Ask about the most recent day in the last 28, taken from `session.list`: **"Was <that day> a real workout, or a test?"** The attendance goal starts from it.

### Step 2. Bodyweight

The health system owns the weigh-in log (ruling e). `profile.log_bodyweight` **copies the health log's value for that date**. It never records a separate reading (`sources/design/2026-09-19-health-workout-merge-review.md`, step 1).

Ask: **"What does your health log show for this morning's weight?"** If they have not weighed in yet, ask them to log it in the health system first, then give you the number.

```
profile.log_bodyweight {bodyweightLbs: <the health log's number>,
                        measuredAt: <the health log's time for that reading>,
                        note: "copied from the health log"}
```

- Pass leanness fields (`leannessBand`, `waistIn`, `bodyFatPct` with `bodyFatSource`) only if they volunteer them. Never ask for them. Never suggest going to get measured.
- A wrong entry: call again with the same `measuredAt` and restate the whole reading. The update replaces every optional field.
- If earlier readings from this week exist in the health log and the owner offers them, copy each one with its own `measuredAt`. The goal's start value is the mean of the readings in the last 30 days, so more readings make a steadier start.

Read back: "Logged <n> lb for this morning, copied from your health log." Then say what one reading can and cannot do. The 7-day mean needs 3 readings in 7 days. A rate verdict needs about two weeks of weigh-ins after the first reading. No tool returns a review date, so say the rule and name no date.

### Step 3. The break-length question

If `lastBreakQuestion` came back in Step 1, ask it **as written**. If it did not, ask: **"How many months did your most recent break from consistent training last? The length of the break, not how long ago it ended. Zero if none."**

Do not suggest an answer. If the stored `currentBaseline` text already names a break, read its length back. If their answer disagrees with it, say so once and let them choose which is right.

```
profile.set_training_background {lastBreakMonths: <their number>}
profile.get_tier_signal
```

Read back `tier`, `declared`, `confidence`, `ceilingBasis` and `evidence.trainingDaysLogged`, in plain words. Repeat the test-session caveat beside `trainingDaysLogged`.

| Answer                                                                                                              | What the signal does                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Under 12 months (with a year or more of declared training, a reported plateau, and no logged gap of a year or more) | The returner path opens. `ceilingBasis: "returner"`. `tier` stays at the declared tier, with `confidence: "provisional"`. Say both.                                                                                                                                          |
| 12 months or more                                                                                                   | The returner path stays closed. `ceilingBasis: null`. `tier` reads **beginner**, `source: "derived"`, `confidence: "provisional"`. The ceiling lifts on logged history: 24 training days across 12 weeks. Say that this is a ceiling on confidence, not a judgement of them. |

What the answer changes, exactly:

- **Goal bands are sized by the declared tier, not the clamped one.** A 12-month-plus answer does not shrink a lift's ramp. It stamps each target `tierProvisional: true`, and that stamp is fixed with the target. Say so when you read a proposal out.
- **The clamped tier drives the rest**: warm-up rung count, whether progression may add a set, the plan's volume ceilings, and the starting prescription.

This comes before goals so the stamp on every target is right from the start.

If time allows, ask the next one or two `missing[]` items in the order given (expect `goal`, then `target`, then `reportedSetsPerMuscle`, `namedProgramHistory`, `injuries`). `injuries: []` means "asked, none". Stop when they are tired of questions; the sitting does not depend on the rest.

### Step 4. Diet phase, and the weekly check-in

Ask: **"Which diet phase are you actually in right now: fat loss, gain, maintenance, or recomposition? And when did it start?"**

If they say recomposition, ask: **"Hold your weight, or a slow deliberate loss?"** Never infer this from the scale. `recompMode` is refused for any other phase.

```
profile.set_diet_phase {phase: "fat-loss" | "gain" | "maintenance" | "recomposition",
                        startedAt?: <if earlier than now>,
                        recompMode?: "hold" | "slow-loss"}
```

Read the returned timeline back, oldest first, so they can confirm it landed where they meant.

Say once what the phase does to a bodyweight goal. The tool's own numbers win; these are what to expect:

| Phase                                 | Committed edge                                         | Stretch edge      |
| ------------------------------------- | ------------------------------------------------------ | ----------------- |
| Fat loss                              | minus 0.5% a week                                      | minus 1% a week   |
| Gain                                  | plus 0.25% a week                                      | plus 0.5% a week  |
| Maintenance, or recomposition on hold | a corridor of plus or minus 2% around the start weight | the same corridor |
| Recomposition on slow-loss            | hold the start weight                                  | minus 0.5% a week |

With **no** phase declared, a bodyweight goal silently becomes the maintenance corridor, and once accepted it stays that way. That is why this step comes before goals.

**You size no calories.** The health system owns calorie and macro sizing. If they ask how much to eat, say that belongs to the health coach and the health log.

Then the Sunday check-in. One question, all three optional: **"Quick check-in for the week: hunger, how closely you followed your eating plan, and sleep. Low, medium or high for each, or skip any."**

```
profile.log_weekly_checkin {hunger?, dietPlanAdherence?, sleepQuality?}
```

Call it even if they skip all three. An empty check-in is different from none.

### Step 5. Date the next block

`planning.due` was true in Step 1, so ask the prompt's question: **"Your next block is due to be planned. Plan it now?"** Create nothing until they say yes. Ruling (b) sets the shape: the next undated block starts the first Monday after this sitting and runs as the re-entry block.

```
plan.block.planning_brief    → state, planning, finishing, next, suggested, conflicts, realignment, dietPhase
```

Read back, from the result and not from memory:

- `finishing`: expect **null**, and `realignment`: expect **null**. No block has dates, so the server treats none as finishing. Do not invent a read of an earlier undated block. If the owner asks, say it was never dated and stays as undated history.
- `next.block`: the next undated block. Read its name, `weeksCount` and `next.weekRows` back, and each week's name and workouts from `plan.block.calendar` after dating. The server picks the first block of the program with no workout ever done. If `next` is null or names a block that does not look like the re-entry block, stop and ask.
- `suggested.startsOn` and `suggested.endsOn`: expect the first Monday on or after today, and the Sunday that ends the block's weeks. Compare `startsOn` with ruling (b), the first Monday after this sitting. They match unless the sitting falls on a Monday, when `suggested.basis` counts today. Then say so and ask which Monday they want. `suggested.deloadWeek`: expect null. `suggested.basis`: "the first Monday from today, counting today when it is a Monday".
- `conflicts`: expect none.
- `dietPhase`: now set from Step 4. If it still reads null, go back to Step 4.

Ask: **"Start <next.block.name> on <weekday and date of suggested.startsOn>, <weeksCount> weeks, ending <weekday and date of suggested.endsOn>?"** On yes:

```
plan.block.schedule {blockId: <next.block.id from the brief>, startsOn: <the Monday they confirmed>,
                     reason: <their words, or "first dated block">}
plan.block.calendar {blockId}
```

The confirmed Monday is `suggested.startsOn`, or another Monday they chose. For another Monday, take it from the Mondays a `NOT_A_MONDAY` refusal lists on either side of a date, or from `plan.block.calendar` for a block already dated. Never compute it yourself.

Read back the start, the end, the weeks and their template counts from the calendar. A week with `templateCount: 0` has nothing planned; say so if you see one.

A refusal names its cause. `NOT_A_MONDAY` gives the Mondays either side. `SCHEDULE_OVERLAP` and `SCHEDULE_ORDER` name the other block. `BLOCK_WOULD_BE_ENDED` means the start is too far back. If the sitting slips to a Monday or Tuesday, the earlier Monday of that same week is still accepted: a block begun this week may be dated after its Monday.

Say the missed-week rule now, once: "If you miss a week, I will ask whether to hold the calendar or push the block a week later. I will ask every time."

### Step 6. DECISION POINT: which first goals

The owner said: "Decide at the sitting." Put the choice to them with the facts. Do not steer beyond the facts.

**Option A. Attendance and bodyweight first.** Two whole-body goals. Both start from something measured. Lift goals wait one or two weeks until the block's load discovery has put labelled working sets on record.

**Option B. Lift goals too.** Add one or two lifts or muscles. Facts to state:

- **Lift goals are now safe to accept.** The roadmap's rule was "accept lift targets only after the per-class ramp merges." It merged (#470), and so did the block calendar for targets (#473). The old reason to wait is gone.
- Most lifts have few labelled working sets, and many stored sets were bench tests. A lift target will come back `cold` (the generic starting ramp, no claim about strength) or `skipped` (no working set on record). Read `skipped[].reason` out; do not argue with it.
- A cold target's start value may rest on a test pull. Ask the owner whether the start value it shows is a real working load before they accept. If it is not, the honest move is to wait for S1.
- A cold target, once accepted, stays the starting ramp. When the lift calibrates, the coach offers a data-based target once (`recalibrationOffers`).
- Accepted numbers are fixed. Waiting costs nothing. An early acceptance is undone only by `goal.retire`.
- More than 2 specialized items draws an advisory warning. In a fat-loss phase the coach offers to move a specialized item to maintain.

**Facts that apply to both options.**

- Goals declared after Step 5 bind to the block you just dated. They take its weeks and its end, `suggested.endsOn`. They are re-proposed at the planning sitting held in that block's last week (ruling b).
- Until the block starts it is upcoming. The goals page shows "Starts <suggested.startsOn>" for each target and draws no verdict. That is correct, not a fault.
- Goal weeks are local calendar weeks, Monday to Sunday.
- A short block is too short for a bodyweight rate verdict. The first bodyweight goal is mostly a record of the start weight and the band.

Ask: **"Attendance and bodyweight only, or lift goals as well? And which lifts or muscles?"** Take priorities in their words. Ask the level for each lift or muscle: specialize, maintain, or deprioritize.

### Step 7. Declare priorities

```
goal.declare_priorities {items: [
  {kind: "muscle", ref: "sessions",   level: "maintain"},     # attendance (a whole-body ref rides kind "muscle")
  {kind: "muscle", ref: "bodyweight", level: "maintain"},     # bodyweight
  # Option B only, in their words:
  # {kind: "lift",   ref: "<exerciseId from exercise.search>", level: "specialize"},
  # {kind: "muscle", ref: "back" | "arms" | "legs" | ...,      level: "specialize"}
]}
```

Read back `block` (expect `{id: <the id you just dated>, defaulted: true}`; compare the id), `tierUsed` (expect the declared tier), `dietPhase` (expect the Step 4 phase, not `unknown`), and every `warnings[]` entry in plain words. Warnings are advisory: the declaration is stored exactly as made.

If `proposals[]` carries the fat-loss downgrade offer, **relay it and wait**. Accept: declare that item again at `maintain`. Decline: declare it again with `declineFatLossDowngrade: true`. Never apply it yourself.

`GOAL_WHOLE_BODY_PRIORITY_EXISTS` means `sessions`, `bodyweight` or `strength` was already declared, or appears twice in one call. Re-declare the same ref to change its level.

### Step 8. Propose, read out, accept: one priority at a time

```
goal.propose_targets {priorityId}
```

For each target read out: the metric, `startValue` and when it was measured, **both** `committedValue` and `stretchValue`, `infoLevel` in plain words (`cold`: a starting ramp with no gain claim; `ramp`: the programmed increment; `own`: their own fitted trend), `tierProvisional` when true, and the `notes`. Never present the committed value alone as the forecast. Read each `skipped[]` reason.

**Bodyweight.** Ask: **"Committed <x>, stretch <y>. Accept as is?"**

```
goal.accept_target {targetId}                      # coach default, on their yes
```

**Attendance: the honest script.** Say all of this before you ask for a number.

1. **What the tool will offer, and why.** "The tool will offer <n> training days in any 28, for both the committed and the stretch edge. It offers <n> because its only input is the count of training days in the last 28 days, and that count is <n>." Take <n> from the proposal's `startValue`. Name the day behind a count of 1 if ruling (a) applies. The band is flat by design. It holds at today's count and never ramps.
2. **What the tool cannot read.** It reads no intended frequency. The profile's reliable days a week and the plan's workouts a week do not reach this number. With no training day in the last 28, the target is `skipped` and no attendance goal can be set at all.
3. **How an intent is still recorded.** The lifter may state their own number on acceptance. "Three days a week" is 12 in 28. "Four" is 16. It is stored as their own number, flagged `acknowledgedStretch`, because nothing in the last 28 days supports it. The band is not redrawn to make it look supported.
4. **How it is judged.** On pace, not against the full count from day one. The goals page pro-rates the committed count over the first 28 days after acceptance. A committed 12 is due 6 by day 14.
5. **What the block can show.** The goal binds to the dated block and ends on `suggested.endsOn`. With perfect attendance the rolling count on that date is at most the planned days in the block (count them from `plan.block.calendar` template counts) plus the count in point 1. The goal is re-proposed at the next planning sitting, and by then the offer will rest on real weeks.

Then give the two honest choices and a recommendation. Do not pick the number.

- **Accept now, with their own number.** They have a commitment on record from day one, which is what VW-236 asks for. It carries the stretch flag, and it is re-proposed in two weeks.
- **Wait two or three weeks.** The first offer then rests on the block's real attendance. The cost is no attendance goal on the page until then.

**Recommend accepting now if they can name a number they believe.** The flag is honest, the pace rule is fair, and the re-proposal is a block away. **Recommend waiting if they cannot name one**, or if the only day behind the start value is a test (then the only evidence is not training).

Ask: **"How many training days in any 28 do you commit to? Is there a higher number you would call a stretch?"** Do not suggest one. If they ask what is realistic, give facts only: the plan's workouts a week from `plan.block.calendar`, the reliable days a week from `profile.get_training_background`, and the count in the last 28 days from the proposal.

```
goal.accept_target {targetId, committedValue: <theirs>, stretchValue: <theirs, or their higher number>, acknowledgeStretch: true}
```

A value under the proposal is refused (`GOAL_TARGET_BELOW_BAND`). A value above it without the flag is refused (`GOAL_TARGET_ABOVE_BAND`). If they choose to wait, leave the proposal unanswered; do not retire it, because a retired proposal is never re-offered.

**Lifts (Option B).** A `reps_at_load` target takes `anchorLoad` so it reads as a whole set ("12 reps at 185 lb"); ask which load they mean. If the target carries `startingRamp`, say: "This is the generic starting ramp, not based on your lifts yet. When the lift calibrates I will offer a data-based target once."

A declined proposal: `goal.retire {targetId, outcome: "abandoned"}`. It is never re-offered. `GOAL_TARGET_FIXED` on a second accept means it is already fixed; say so.

### Step 9. The week ahead (VW-236, VW-505)

Three short asks, then one tool call.

1. **"Which four days this week, and one named fallback day for each?"** A fallback day is never scored as a failure.
2. **"One if-then plan for the most likely thing that gets in the way this week."** In their words: "If <barrier>, then I will <action>."
3. Say once: **"Silence from me through the week means the plan is on track."**

Then `accountability.declare_commitment {days, ifThen, wording}` stores it: their days with a fallback each, the if-then sentence, and the commitment in their own words. Pass their words through unchanged. The tool stores and the coach message renders them verbatim, and a commitment in your words carries none of the weight. `weekOf` defaults to the week being committed to, so a sitting held on Sunday files against the week that starts tomorrow. Declaring again for the same week is a correction; an identical retry changes nothing. It sets no session count: that stays the attendance goal target from Step 8. Ruling (d): no accountability message goes out before this call has landed, so confirm the stored commitment (`accountability.state`) before you say one is coming.

Write these, the chosen attendance number and the first-goals decision into `sources/notes/<sitting date>-sunday-sitting.md`, with the sitting date taken from the session clock. Keep bodyweight and diet detail out of that note; it belongs in the health system's own record. If you cannot write files, read them back in one block for the owner to paste.

### Step 10. Read everything back

```
goal.list                    → priorities with accepted targets (acceptedBy set)
plan.current_block           → expect state: "upcoming", nextBlock: the block you dated, startsOn: the date you confirmed,
                               planning.due: false
profile.get_tier_signal      → the line you read in Step 3
accountability.preview       → optional: what the Sunday coach message would say, rendered from live reads
```

Close with five lines: weight logged, phase declared, tier line, block dates, goals accepted with both edges each. Then the first training day: say the workout name `plan.next_workout` returns for the block's first day, and that you will ask it when they arrive.

Until the block starts, `plan.next_workout` returns `unplanned: true` with `nextBlock` set. That is correct. Do not present a workout from an earlier undated block.

### S0 failure modes

| You see                                                         | Do                                                                                                      |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `plan.current_block` missing                                    | Old server. Stop. Give the owner the restart order from the preflight                                   |
| Bodyweight target `skipped`: no reading in the last 30 days     | Step 2 did not land. Log the weight, then propose again                                                 |
| Sessions target `skipped`: no training days in the last 28 days | Nothing to hold yet. Say so. Re-propose after the first week of the block                               |
| A lift target `skipped`: no working set on record               | Correct for an untrained or unlabelled lift. Re-propose after S1 or S3                                  |
| `block` is null on declare                                      | The block was not dated. Go back to Step 5. A goal with no block runs a generic 12 weeks                |
| The owner wants to change an accepted number                    | It is fixed. `goal.retire` with an honest outcome, then declare and propose again                       |
| `plan.block.schedule` refused                                   | Read the error; it names the conflicting block or the rule                                              |
| The owner wants a longer first horizon                          | Say the fact: goals bound to the block run its weeks. Longer goals are a next-planning-sitting decision |
| The owner asks how many calories                                | Not yours. The health coach sizes intake                                                                |

### Dry run (no device, no risk to the real store)

The coordinator can rehearse this script against a scratch store: a mock-adapter server with `VMCP_DB_PATH` pointed at a copy. The coach never starts servers. In a dry run, `server.health.adapter` reads `mock`; say so at the top so nobody mistakes it for the real sitting. The store to rehearse on holds no dated block, which is the state Step 1 expects. Every date in Steps 2 to 10 must come from a tool result named in the step; a step that needs a date the tools did not give is a defect in this script.

---

## S1. The first training day of the block: Upper A, load discovery (outline)

Workout first. Signal block of at most 10 minutes.

1. Connect (`01`). `plan.next_workout` → expect the block's first week, "Upper A": chest press, row, shoulder press (3 sets of 6 to 10 each), bicep curl, tricep pushdown (3 sets of 10 to 15 each). Read the exact list from the tool. `session.start`, `plan.attach_to_session`.
2. If the owner runs the VW-173 bench check (a spoken "stop" during a cue, three times), that is their bench procedure on their bench build. Your part: keep `midSet` cues off, and do not speak over a loaded cable.
3. Per lift: ascending loads. `plan.warmup_ramp` rungs as `setPurpose: "warmup"`; discovery rungs as `probe`; the sets that count as `working`. Verify every weight change with `get_state`.
4. Last set of **row** and of **chest press** to failure, as familiarisation. Follow the failure-set recipe in `13`. It must be a `working` set of 5 to 12 reps. Not shoulder press: overhead work is excluded.
5. After each working set, ask one question: "How many more reps did you have?" No tool stores a per-set answer yet; put it in the session check-in notes (see `13`).
6. End: `session.end {checkin}`, `plan.complete_workout`, `report.session_results`. The owner has a training day before today, so `soreness`, `joint` and `motivation` are not withheld.
7. Read, do not promise: `rir_velocity.fit {exerciseId}` per failure lift. One session cannot qualify: the fit needs 3 qualifying sets over 2 sessions. `reason` will say which minimum is unmet. Say that.

Signals: load-velocity points, estimated loads for S3, up to 2 failure anchors, the first labelled sets of the block.

## S2. The next training day: Lower A, load discovery (outline)

1. Connect, `plan.next_workout` → "Lower A": squat, Romanian deadlift (6 to 10), lateral raise, face pull (10 to 15).
2. Signal block, first 10 minutes, only if the owner asks for it: a two-unit mode change check (VW-162) and a post-connect state read (VW-415). Your part is `device.set_mode` per slot, `device.get_state`, and reporting `requested_mode` against `active_mode` and `state_confirmed` exactly as read.
3. Lower-body load discovery. **No failure sets**: spinal-loaded and single-leg movements are excluded.
4. Label every set. Read `progression.get_for_exercise {exerciseId}` for each lower-body lift before the first set. If it shows no labelled working sets, these sets are the first start values for any lower-body goal.
5. End as S1.

## S3. The third training day: Upper B, the second failure session (outline)

At least 72 h after S1.

1. Connect, `plan.next_workout` → "Upper B": lat pulldown, single-arm row, chest fly, hammer curl, overhead tricep extension.
2. **Decision for the owner, ask at the start:** the fit needs a second session of failure sets on the same lifts as S1 (cable row and cable chest press). Upper B's template does not hold those two lifts. Either add them today as extra sets (`session.set_exercise` to each, `working`, to failure), or wait for the second week's Upper A (the date is in `plan.block.calendar`). State the trade: today gets a first fit sooner; waiting keeps the template as written.
3. If they choose today: two failure sets each on row and chest press at the S1 loads, and one on lat pulldown. Recipe in `13`. Overhead tricep extension is never taken to failure here.
4. After the session: `rir_velocity.fit {exerciseId}` for row and press. Read `fitted`, `reason` and `qualification` out. The owner's chosen minimum is 4 to-failure sets per lift over 2 sessions 72 h apart; the server's own floor is 3 sets over 2 sessions, 12 reps in all, spread across at least 3 reps in reserve.
5. A fit that exists is **not yet trusted**. The server trusts a curve whose fit error (`model.rirErrorReps`) is under 2 reps. The owner's gate is stricter: one more held-out failure set in Week 2 that the curve predicts within 1.5 reps. Until both hold you still state no RPE and no reps in reserve.
6. `profile.get_tier_signal`: training days logged moves toward 24.

## The Sunday review (from the first Sunday after the block starts)

```
profile.log_bodyweight                     # copy today's reading from the health log, if there is one
profile.log_weekly_checkin {…}             # hunger, adherence, sleep; all optional
goal.weekly_review                         # observation, advisory, levers, vetoes, proposal
report.weekly                              # training days, planned vs done, per-session results
plan.current_block                         # planning.due appears from the Monday of the block's last week
```

Depth in `09` and `10`. Relay the advisory; never size it. If `proposal` is present, ask, then call `goal.weekly_review {response}` with their answer. If a week was missed, ask hold or extend (`11`).

The merge review recommends one Sunday coach over both the health and the workout systems. That is an owner decision, not yet made. Until it is, this review covers training and the bodyweight rate only, and it names the health coach for anything about intake.

## The next planning sitting (in the dated block's last week)

Ruling (b): planning for the block after the re-entry block waits until that block's last week. `plan.current_block` → `planning.due`. It turns true on the first day of the dated block's last week, while nothing is dated after it. Read the date from `plan.current_block`, not from memory. Ask first. Then `plan.block.planning_brief`. This time `finishing` is the block just run, with `trained` and `realignment` filled in. Date or create the block, relay the `realignment` re-ask (keep, restate, re-architect), declare priorities for the new block, propose, accept. Depth in `11`.

## Cross-refs

- Goals, acceptance rules, the weekly review: `09-goals-and-weekly-review.md`
- Weigh-ins, diet phase, check-in, rate advisory: `10-bodyweight-diet-phase-rate-advisory.md`
- Block dates, missed weeks, planning brief: `11-dated-blocks-and-planning-sitting.md`
- Break length and the tier signal: `12-onboarding-gaps-and-tier-signal.md`
- Failure sets and what you may claim about effort: `13-effort-rir-and-failure-sets.md`
