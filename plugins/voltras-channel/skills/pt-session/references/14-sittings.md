# Sittings

**When to read this.** The user wants the Sunday sitting, first goals, a weekly review, or a planning sitting; OR it is one of the first four signal sittings (S0 to S3) from the gated roadmap (`sources/design/2026-09-19-voltras-gated-roadmap.md`, section 6).

A sitting is a conversation with tool calls. S0 has no device: no scan, no lease, no session. S1 to S3 are real workouts with a short signal block.

The order inside a sitting matters because **an accepted target never moves**. Facts first, then dates, then priorities, then proposals, then acceptance.

Verified 2026-09-19 against voltras-mcp main (#473, store schema 34) and a read-only look at the owner's store. Every "expect" below is what that store held on that day. If a read differs, stop and say what you found.

## Preflight: is the live server on main?

Do this before anything else, in every sitting.

```
server.health                → adapter: "node" (not "mock"); dbPath is the real store
plan.current_block           → the tool must exist
```

`server.health` may report `build: "unknown"`, so the build field proves nothing. The test is a tool that exists only on main. `plan.current_block` is one. If it is missing, the server is older than the dated-block work: no block dates, no planning brief, no `plan.week.skip`.

**If the tool is missing, stop.** Say: "This server cannot date a block. It needs a restart onto current main before we do this." Do not substitute `plan.block.create` without dates. Do not run the rest of the sitting on the old server: goals declared there bind to no block and run a generic 12 weeks, and acceptance fixes that.

On 2026-09-19 at 15:25 the owner's store was at schema 31 and main was at 34, so the live server had **not** been restarted onto main. Tell the owner the restart order. **You never perform these steps yourself.** They come from the gated roadmap, section 6:

1. Back up `~/.voltras/vmcp.sqlite` to a dated `.bak` file. The roadmap advises testing the migration on a copy first.
2. Update and rebuild the main checkout.
3. Restart the live server. Migrations 32 to 34 run together. The VW-462 notes say they touch zero rows on this store.
4. Do not start the VW-173 bench build from PR #247 until its branch is updated from main. That build still expects schema 31, and the store will be at 34.

Then run the preflight again and start the sitting.

---

## S0. Sunday 2026-09-20: first goals, bodyweight, break length, diet phase, Block 2 dates, priorities

No device. 30 to 40 minutes. Say the plan in one breath first: "Six things: your weight, one question about your last break, your diet phase, dates for Block 2, what you want to emphasise, then the numbers. I ask, you decide, I read everything back."

### Step 1. Orient (reads only, say little)

```
plan.current_block           → expect state: "undated_only", program "Voltra Return — 2026",
                               block: null, nextBlock: null,
                               planning.due: true, planning.reason: "No block has dates yet."
goal.list                    → expect no priorities
profile.get_onboarding_gaps  → missing[], lastBreakQuestion, goalRealism, medicalClearanceRequired
profile.get_body_metrics     → expect no readings
profile.get_training_background → the stored answers (declared intermediate, 2 years, plateau yes,
                               4 days available, 4 reliable; goal, target and injuries unanswered)
```

If any read surprises you (a dated block already exists, priorities already exist, a bodyweight is already logged), stop and tell the owner what you found before you write anything.

If `medicalClearanceRequired` is true, read `medicalClearanceNote` as written and go no further into programming.

**Session kinds first, if the server has them (VW-489, #479, store schema 35).** Call `session.review_list`. If the tool exists, the owner has already ruled for this sitting, on 2026-09-19, verbatim: "mark everything test for now". So:

1. Read the list back as a count only: "N days are unreviewed. You told me to mark them all as tests for now." Take `from` and `to` from the oldest and newest day on the list. On 2026-09-19 a rehearsal on a copy of the store gave 21 days, 2026-05-04 to 2026-09-07, 85 sessions; trust the live reads over these numbers.
2. Dry run: `session.mark_kind { "kind": "test", "from": "<oldest>", "to": "<newest>", "dryRun": true }`. Read back `newlyClassified`, `reclassified`, `skippedAlreadyMarked` and the day count. Expect `reclassified: 0`.
3. On the owner's "yes", the real call: the same input without `dryRun`, plus `"expectSessions": <the newlyClassified count the dry run gave>`. Without it the tool refuses and names the count; that is one retry, not a fault. Then `session.review_list` should return no unreviewed day. Read `rederiveFailed` in the result: expect it empty. If it names an exercise, the mark is still saved; run `baselines.recalc` and `rir_velocity.fit` for each named exercise and say so.
4. Say once: "Any of those you later tell me was a real workout, I re-mark as training. I never guess." Re-marking one of these days later needs `reclassify: true`, because it is no longer unreviewed.

This ruling is for this sitting's backlog only. At every later sitting, ask about each unreviewed day.

What changes after the marking, so re-read everything below from the tools and trust the tool over this script: training days read 0; the 28-day count is 0, so the attendance target comes back `skipped` and no attendance goal can be set today (say so plainly and move on; it is re-proposed once real training days exist); lift proposals have no training history behind them, so expect cold starting values or skips, and read out exactly what `goal.propose_targets` returns; the tier signal's evidence shows 0 logged days and stays beginner, provisional. Do not re-mark a day to make a goal possible.

**If `session.review_list` does not exist**, the server predates session kinds. Then ask before you treat past days as training. The owner said on 2026-09-19 that most stored sessions were bench tests, not training. Every count of "logged training days" is overstated, and any start value may rest on a test pull. Do not call the 18 to 21 logged days a training history. Ask: **"Was 7 September a real workout, or a test?"** It is the only day in the last 28, and the attendance goal starts from it.

### Step 2. Bodyweight

The health system owns the weigh-in log. Until a shared record exists, `profile.log_bodyweight` **copies the health log's value for that date**. It never records a separate reading (`sources/design/2026-09-19-health-workout-merge-review.md`, step 1).

Ask: **"What does your health log show for this morning's weight?"** If they have not weighed in yet, ask them to log it in the health system first, then give you the number.

```
profile.log_bodyweight {bodyweightLbs: <the health log's number>,
                        measuredAt: <the health log's time for that reading>,
                        note: "copied from the health log"}
```

- Pass leanness fields (`leannessBand`, `waistIn`, `bodyFatPct` with `bodyFatSource`) only if they volunteer them. Never ask for them. Never suggest going to get measured.
- A wrong entry: call again with the same `measuredAt` and restate the whole reading. The update replaces every optional field.
- If earlier readings from this week exist in the health log and the owner offers them, copy each one with its own `measuredAt`. The goal's start value is the mean of the readings in the last 30 days, so more readings make a steadier start.

Read back: "Logged <n> lb for this morning, copied from your health log." Then say what one reading can and cannot do. The 7-day mean needs 3 readings in 7 days. A rate verdict needs about two weeks of weigh-ins. The first real rate review is about Sunday 2026-10-04.

### Step 3. The break-length question

If `lastBreakQuestion` came back in Step 1, ask it **as written**. If it did not, ask: **"How many months did your most recent break from consistent training last? The length of the break, not how long ago it ended. Zero if none."**

Do not suggest an answer. The stored `currentBaseline` text already names a break of about 20 months. If their answer disagrees with it, say so once and let them choose which is right.

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

### Step 5. Date Block 2

`planning.due` was true in Step 1, so ask the prompt's question: **"Your next block is due to be planned. Plan it now?"** Create nothing until they say yes.

```
plan.block.planning_brief    → state, planning, finishing, next, suggested, conflicts, realignment, dietPhase
```

Read back, from the result and not from memory:

- `finishing`: expect **null**, and `realignment`: expect **null**. No block has dates, so the server treats none as finishing. Do not invent a read of Block 1. If the owner asks: Block 1 was never dated, one of its two workouts was done once, and it stays as undated history.
- `next.block.name`: expect "Block 2 — Orientation" (`weeksCount: 2`, `next.weekRows: 2`; Week 1 "Load Discovery" and Week 2 "Confirm", each with Upper A, Lower A, Upper B, Lower B). The server picks it because it is the first block of the program with no workout ever done. If `next` names another block, stop and ask.
- `suggested.startsOn`: expect `2026-09-21`. `suggested.endsOn`: expect `2026-10-04`. `suggested.deloadWeek`: expect null. `suggested.basis`: "the first Monday from today, counting today when it is a Monday".
- `conflicts`: expect none.
- `dietPhase`: now set from Step 4. If it still reads null, go back to Step 4.

Ask: **"Start Block 2 on Monday 21 September, two weeks, ending Sunday 4 October?"** On yes:

```
plan.block.schedule {blockId: <next.block.id from the brief>, startsOn: "2026-09-21",
                     reason: <their words, or "first dated block">}
plan.block.calendar {blockId}
```

Read back the start, the end, the two weeks and their template counts (expect 4 and 4) from the calendar. A week with `templateCount: 0` has nothing planned; say so if you see one.

A refusal names its cause. `NOT_A_MONDAY` gives the Mondays either side. `SCHEDULE_OVERLAP` and `SCHEDULE_ORDER` name the other block. `BLOCK_WOULD_BE_ENDED` means the start is too far back. If the sitting slips to Monday or Tuesday, `2026-09-21` is still accepted: a block begun this week may be dated after its Monday.

Say the missed-week rule now, once: "If you miss a week, I will ask whether to hold the calendar or push the block a week later. I will ask every time."

### Step 6. DECISION POINT: which first goals

The owner said: "Decide at the sitting." Put the choice to them with the facts. Do not steer beyond the facts.

**Option A. Attendance and bodyweight first.** Two whole-body goals. Both start from something measured. Lift goals wait one or two weeks until Block 2's load discovery has put labelled working sets on record.

**Option B. Lift goals too.** Add one or two lifts or muscles. Facts to state:

- **Lift goals are now safe to accept.** The roadmap's rule was "accept lift targets only after the per-class ramp merges." It merged (#470), and so did the block calendar for targets (#473). The old reason to wait is gone.
- Most lifts have few labelled working sets, and many stored sets were bench tests. A lift target will come back `cold` (the generic starting ramp, no claim about strength) or `skipped` (no working set on record). Read `skipped[].reason` out; do not argue with it.
- A cold target's start value may rest on a test pull. Ask the owner whether the start value it shows is a real working load before they accept. If it is not, the honest move is to wait for S1.
- A cold target, once accepted, stays the starting ramp. When the lift calibrates, the coach offers a data-based target once (`recalibrationOffers`).
- Accepted numbers are fixed. Waiting costs nothing. An early acceptance is undone only by `goal.retire`.
- More than 2 specialized items draws an advisory warning. In a fat-loss phase the coach offers to move a specialized item to maintain.

**Facts that apply to both options.**

- Goals declared after Step 5 bind to Block 2. They take its weeks and its end, 2026-10-04. They are re-proposed at the Block 3 planning sitting.
- Until Monday the block is upcoming. The goals page shows "Starts 2026-09-21" for each target and draws no verdict. That is correct, not a fault.
- Goal weeks are local calendar weeks, Monday to Sunday.
- Two weeks is too short for a bodyweight rate verdict. The first bodyweight goal is mostly a record of the start weight and the band.

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

Read back `block` (expect `{id: <the Block 2 id you just dated>, defaulted: true}`; compare the id), `tierUsed` (expect the declared tier), `dietPhase` (expect the Step 4 phase, not `unknown`), and every `warnings[]` entry in plain words. Warnings are advisory: the declaration is stored exactly as made.

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

1. **What the tool will offer, and why.** "The tool will offer 1 training day in any 28, for both the committed and the stretch edge. It offers 1 because its only input is the count of training days in the last 28 days, and that count is 1: 7 September." The band is flat by design. It holds at today's count and never ramps.
2. **What the tool cannot read.** It reads no intended frequency. The profile's 4 reliable days a week and the plan's 4 workouts a week do not reach this number. With no training day in the last 28, the target is `skipped` and no attendance goal can be set at all.
3. **How an intent is still recorded.** The lifter may state their own number on acceptance. "Three days a week" is 12 in 28. "Four" is 16. It is stored as their own number, flagged `acknowledgedStretch`, because nothing in the last 28 days supports it. The band is not redrawn to make it look supported.
4. **How it is judged.** On pace, not against the full count from day one. The goals page pro-rates the committed count over the first 28 days after acceptance. A committed 12 is due 6 by day 14.
5. **What two weeks can show.** The goal binds to Block 2 and ends 2026-10-04. With perfect attendance the rolling count on that date is at most 9: 8 planned days plus 7 September. The goal is re-proposed at the Block 3 sitting, and by then the offer will rest on real weeks.

Then give the two honest choices and a recommendation. Do not pick the number.

- **Accept now, with their own number.** They have a commitment on record from day one, which is what VW-236 asks for. It carries the stretch flag, and it is re-proposed in two weeks.
- **Wait two or three weeks.** The first offer then rests on Block 2's real attendance. The cost is no attendance goal on the page until then.

**Recommend accepting now if they can name a number they believe.** The flag is honest, the pace rule is fair, and the re-proposal is two weeks away. **Recommend waiting if they cannot name one**, or if 7 September was a test (then the only evidence behind the start value is not training).

Ask: **"How many training days in any 28 do you commit to? Is there a higher number you would call a stretch?"** Do not suggest one. If they ask what is realistic, give facts only: the plan is 4 days a week, the profile says 4 reliable days, and the last 28 days hold 1 training day.

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

Then `accountability.declare_commitment {days, ifThen, wording}` stores it: their days with a fallback each, the if-then sentence, and the commitment in their own words. Pass their words through unchanged. The tool stores and the Sunday message renders them verbatim, and a commitment in your words carries none of the weight. `weekOf` defaults to the week being committed to, so a Sunday sitting files against tomorrow. Declaring again for the same week is a correction; an identical retry changes nothing. It sets no session count: that stays the attendance goal target from Step 8.

Write these, the chosen attendance number and the first-goals decision into `sources/notes/2026-09-20-sunday-sitting.md`. Keep bodyweight and diet detail out of that note; it belongs in the health system's own record. If you cannot write files, read them back in one block for the owner to paste.

### Step 10. Read everything back

```
goal.list                    → priorities with accepted targets (acceptedBy set)
plan.current_block           → expect state: "upcoming", nextBlock: Block 2, startsOn 2026-09-21,
                               planning.due: false
profile.get_tier_signal      → the line you read in Step 3
accountability.preview       → optional: what the Sunday coach message would say, rendered from live reads
```

Close with five lines: weight logged, phase declared, tier line, Block 2 dates, goals accepted with both edges each. Then Monday: "Upper A, load discovery. I will ask `plan.next_workout` when you arrive."

On Sunday itself `plan.next_workout` returns `unplanned: true` with `nextBlock` set, because Block 2 has not started. That is correct. Do not present a workout from Block 1.

### S0 failure modes

| You see                                                         | Do                                                                                               |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `plan.current_block` missing                                    | Old server. Stop. Give the owner the restart order from the preflight                            |
| Bodyweight target `skipped`: no reading in the last 30 days     | Step 2 did not land. Log the weight, then propose again                                          |
| Sessions target `skipped`: no training days in the last 28 days | Nothing to hold yet. Say so. Re-propose after the first week of Block 2                          |
| A lift target `skipped`: no working set on record               | Correct for an untrained or unlabelled lift. Re-propose after S1 or S3                           |
| `block` is null on declare                                      | The block was not dated. Go back to Step 5. A goal with no block runs a generic 12 weeks         |
| The owner wants to change an accepted number                    | It is fixed. `goal.retire` with an honest outcome, then declare and propose again                |
| `plan.block.schedule` refused                                   | Read the error; it names the conflicting block or the rule                                       |
| The owner wants a longer first horizon                          | Say the fact: goals bound to Block 2 run two weeks. Longer goals are a Block 3 planning decision |
| The owner asks how many calories                                | Not yours. The health coach sizes intake                                                         |

### Dry run (no device, no risk to the real store)

The coordinator can rehearse this script against a scratch store: a mock-adapter server with `VMCP_DB_PATH` pointed at a copy. The coach never starts servers. In a dry run, `server.health.adapter` reads `mock`; say so at the top so nobody mistakes it for the real sitting.

---

## S1. Monday 2026-09-21: Upper A, load discovery (outline)

Workout first. Signal block of at most 10 minutes.

1. Connect (`01`). `plan.next_workout` → expect Block 2, Week 1, "Upper A": chest press, row, shoulder press (3 sets of 6 to 10 each), bicep curl, tricep pushdown (3 sets of 10 to 15 each). `session.start`, `plan.attach_to_session`.
2. If the owner runs the VW-173 bench check (a spoken "stop" during a cue, three times), that is their bench procedure on their bench build. Your part: keep `midSet` cues off, and do not speak over a loaded cable.
3. Per lift: ascending loads. `plan.warmup_ramp` rungs as `setPurpose: "warmup"`; discovery rungs as `probe`; the sets that count as `working`. Verify every weight change with `get_state`.
4. Last set of **row** and of **chest press** to failure, as familiarisation. Follow the failure-set recipe in `13`. It must be a `working` set of 5 to 12 reps. Not shoulder press: overhead work is excluded.
5. After each working set, ask one question: "How many more reps did you have?" No tool stores a per-set answer yet; put it in the session check-in notes (see `13`).
6. End: `session.end {checkin}`, `plan.complete_workout`, `report.session_results`. The owner has a training day before today, so `soreness`, `joint` and `motivation` are not withheld.
7. Read, do not promise: `rir_velocity.fit {exerciseId}` per failure lift. One session cannot qualify: the fit needs 3 qualifying sets over 2 sessions. `reason` will say which minimum is unmet. Say that.

Signals: load-velocity points, estimated loads for S3, up to 2 failure anchors, the first labelled Block 2 sets.

## S2. Tuesday 2026-09-22: Lower A, load discovery (outline)

1. Connect, `plan.next_workout` → "Lower A": squat, Romanian deadlift (6 to 10), lateral raise, face pull (10 to 15).
2. Signal block, first 10 minutes, only if the owner asks for it: a two-unit mode change check (VW-162) and a post-connect state read (VW-415). Your part is `device.set_mode` per slot, `device.get_state`, and reporting `requested_mode` against `active_mode` and `state_confirmed` exactly as read.
3. Lower-body load discovery. **No failure sets**: spinal-loaded and single-leg movements are excluded.
4. Label every set. The store has no labelled lower-body training sets, so these are the first start values for any lower-body goal.
5. End as S1.

## S3. Thursday 2026-09-24: Upper B, the second failure session (outline)

At least 72 h after S1.

1. Connect, `plan.next_workout` → "Upper B": lat pulldown, single-arm row, chest fly, hammer curl, overhead tricep extension.
2. **Decision for the owner, ask at the start:** the fit needs a second session of failure sets on the same lifts as S1 (cable row and cable chest press). Upper B's template does not hold those two lifts. Either add them today as extra sets (`session.set_exercise` to each, `working`, to failure), or wait for Week 2's Upper A on Monday 2026-09-28. State the trade: today keeps the roadmap's date for a first fit; waiting keeps the template as written.
3. If they choose today: two failure sets each on row and chest press at the S1 loads, and one on lat pulldown. Recipe in `13`. Overhead tricep extension is never taken to failure here.
4. After the session: `rir_velocity.fit {exerciseId}` for row and press. Read `fitted`, `reason` and `qualification` out. The owner's chosen minimum is 4 to-failure sets per lift over 2 sessions 72 h apart; the server's own floor is 3 sets over 2 sessions, 12 reps in all, spread across at least 3 reps in reserve.
5. A fit that exists is **not yet trusted**. The server trusts a curve whose fit error (`model.rirErrorReps`) is under 2 reps. The owner's gate is stricter: one more held-out failure set in Week 2 that the curve predicts within 1.5 reps. Until both hold you still state no RPE and no reps in reserve.
6. `profile.get_tier_signal`: training days logged moves toward 24.

## The Sunday review (from 2026-09-27)

```
profile.log_bodyweight                     # copy today's reading from the health log, if there is one
profile.log_weekly_checkin {…}             # hunger, adherence, sleep; all optional
goal.weekly_review                         # observation, advisory, levers, vetoes, proposal
report.weekly                              # training days, planned vs done, per-session results
plan.current_block                         # planning.due appears from Monday 2026-09-28
```

Depth in `09` and `10`. Relay the advisory; never size it. If `proposal` is present, ask, then call `goal.weekly_review {response}` with their answer. If a week was missed, ask hold or extend (`11`).

The merge review recommends one Sunday coach over both the health and the workout systems. That is an owner decision, not yet made. Until it is, this review covers training and the bodyweight rate only, and it names the health coach for anything about intake.

## The Block 3 planning sitting (about 2026-10-03)

`plan.current_block` → `planning.due`. It turns true on Monday 2026-09-28, the first day of Block 2's last week, while nothing is dated after it. Ask first. Then `plan.block.planning_brief`. This time `finishing` is Block 2, with `trained` and `realignment` filled in. Date or create the block, relay the `realignment` re-ask (keep, restate, re-architect), declare priorities for the new block, propose, accept. Depth in `11`.

## Cross-refs

- Goals, acceptance rules, the weekly review: `09-goals-and-weekly-review.md`
- Weigh-ins, diet phase, check-in, rate advisory: `10-bodyweight-diet-phase-rate-advisory.md`
- Block dates, missed weeks, planning brief: `11-dated-blocks-and-planning-sitting.md`
- Break length and the tier signal: `12-onboarding-gaps-and-tier-signal.md`
- Failure sets and what you may claim about effort: `13-effort-rir-and-failure-sets.md`
