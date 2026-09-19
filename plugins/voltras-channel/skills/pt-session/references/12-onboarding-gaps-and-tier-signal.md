# Onboarding gaps and the tier signal

**When to read this.** It is the start of a workout or a sitting; OR `profile.get_onboarding_gaps` returned `missing[]`, `lastBreakQuestion` or `medicalClearanceRequired`; OR you are about to make a tier-gated call (warm-up rungs, adding a set, a starting prescription); OR the user asks "what level am I?"

Verified 2026-09-19 against voltras-mcp main (#455, #457, #460, #464).

## Tools

| Tool                                       | What it does                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `profile.get_onboarding_gaps`              | Which session-zero answers are still missing, in the order to ask them. Reads only                            |
| `profile.set_training_background {…}`      | Stores the lifter's own answers. A merge, with one exception (below)                                          |
| `profile.get_training_background`          | Reads the stored answers. `profile: null` means nothing captured                                              |
| `profile.get_tier_signal`                  | A crude ceiling on the declared tier, from the profile and the logged history. Reads only                     |
| `profile.get_starting_prescription`        | A conservative seed (sessions a week, sets per exercise, an RIR target) keyed off the tier signal. Reads only |
| `coaching.explain {topic: "onboarding.*"}` | `tier_inference`, `frequency_negotiation`, `goal_commitment_alignment`, `injury_intake`                       |

## Session zero: ask what is missing, in order

```
profile.get_onboarding_gaps  → missing[], lastBreakQuestion, goalRealism,
                               medicalClearanceRequired, medicalClearanceNote
```

`missing[]` is exactly the unanswered fields, in this order: `goal`, `daysAvailable`, `daysReliable`, `currentBaseline`, `effortTolerance`, `target`, `declaredTier`, `yearsTraining`, `lastBreakMonths`, `historyConsistent`, `everPlateaued`, `reportedSetsPerMuscle`, `namedProgramHistory`, `injuries`.

- **Ask the first missing item, not a list of your own.** One or two questions a session. Stop when they are tired of questions.
- Store each answer at once: `profile.set_training_background {<field>: <their answer>}`. Pass only the fields you have an answer for. Earlier answers are kept.
- **Store their words. Never infer a tier, and never interpret an injury.**

Fields that are easy to blur. Keep them apart:

| Field                                              | Meaning                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `goal`                                             | What they want, in their words                                                             |
| `target`                                           | Where they want to END UP                                                                  |
| `currentBaseline`                                  | Where they are NOW. Reading a target as a baseline is the classic intake error             |
| `daysAvailable`                                    | Days a week they WANT                                                                      |
| `daysReliable`                                     | Days a week they can DEFINITELY make. Program against this one                             |
| `effortTolerance`                                  | How hard they are willing to be pushed. It changes how a note reads, never a set count     |
| `reportedSetsPerMuscle` with `namedProgramHistory` | A raw set count means nothing without the program it came from                             |
| `everPlateaued`                                    | A real plateau event. It is a better sign of leaving the beginner stage than years trained |

`injuries` is the one field that **replaces** the stored list. Send every injury still standing. Send `[]` for "asked, none", which is a different answer from never asking.

`goalRealism` is the stored goal and target plus the rule for checking commitment against them. It is **prose to apply with the lifter**, never a verdict the tool computed. Null means no goal or target yet.

### The cardiovascular gate

Set `cardioLimitation` on an injury only when the lifter reports a cardiovascular limitation. It is a hard gate to a doctor, not a severity mark for an ache.

When `medicalClearanceRequired` is true: **read `medicalClearanceNote` out as written and route them to a doctor.** Do not interpret it, grade it, or program around it. Other injuries are not a gate and never set the flag.

## The break-length question

`lastBreakMonths` appears in `missing[]` only for a lifter who declared above beginner while their logged history is still short. `lastBreakQuestion` is then the question to ask, **as written**:

> "Before this stretch of training, how many months was your longest recent break from training consistently (about twice a week or more)? Say 0 if you haven't had one."

- It asks for the **length of the break**, not how long ago it ended.
- Do not suggest an answer. If a stored answer (for example the `currentBaseline` text) names a different length, say so once and let them choose.
- Store it: `profile.set_training_background {lastBreakMonths: <their number>}`. Then read the signal again.

## The tier signal

```
profile.get_tier_signal  → tier, confidence, source, derivedCeiling, ceilingBasis, declared, evidence
```

It is a **coarse ceiling on the declared tier, not a validated classification**. How it works:

```
loggedHistoryMet = trainingDaysLogged >= 24  AND  weeksSpanned >= 12
confidence       = loggedHistoryMet ? "confident" : "provisional"
ceiling          = everPlateaued AND (loggedHistoryMet OR returner) ? "intermediate" : "beginner"
tier             = the lower of (declared, else beginner) and ceiling
```

- The ceiling only ever **lowers** the declared tier. It never derives `advanced`.
- `source` is `default` (nothing declared), `declared` (the clamp agreed), or `derived` (the clamp lowered it).
- `ceilingBasis` says which path raised the ceiling: `logged_history`, `returner`, or null when it stayed at beginner. Say which one applied.

**The returner path** needs all of: a year or more of declared training; a last break **under 12 months**; no logged gap of a year or more between training days; and a reported plateau. A returner keeps the declared tier while `confidence` stays `provisional`. Say both. An unanswered break question never opens the path.

**Training days, not session rows.** `evidence.trainingDaysLogged` counts distinct local days with an ended session. A visit logged as twelve sessions is one day. The same rule now counts every lifter-facing attendance figure: `report.weekly`, the accountability message, the rolling 28-day count and the sessions goal.

How to say it:

- Provisional: "The signal reads <tier> for now. It is a ceiling on confidence, not a judgement of you. It lifts with logged training days: 24 across 12 weeks."
- Returner: "You keep <declared tier> because your last break was under a year. Confidence stays provisional until the logged history catches up."
- Clamped: "You declared <declared>. The signal reads <tier> until the history backs it."

### What reads which tier

| Reads the **clamped** `tier`                                                | Reads the **declared** tier                               |
| --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `plan.warmup_ramp` (rung count)                                             | `goal.declare_priorities` (`tierUsed`)                    |
| `plan.suggest_progression` and `report.weekly` (whether a set may be added) | `goal.propose_targets` (the size of a lift's weekly ramp) |
| The plan's volume ceilings in `plan.exercise.create` warnings               |                                                           |
| `profile.get_starting_prescription`                                         |                                                           |

So a lowered tier does **not** shrink a goal's band. It stamps each derived target `tierProvisional: true`, and that stamp is fixed when the target is accepted. Read it out with the proposal.

Check `confidence` and `source` before any tier-gated decision. Never strip the tier from a number you relay from `coaching.explain` or a baseline.

## The history may be bench tests

The owner said on 2026-09-19: "Most of the historical data is from test sessions not actual training." No tool can mark a session as a test yet (VW-489; design in `sources/design/2026-09-19-in-app-coach-chat-design.md`, section 7).

On that day the store held 85 session rows on 21 local days. 24 were never ended. 105 of 177 sets had no exercise. Two or three of the 21 days look like training. That last line is an inference; only the owner can say.

Until a marking tool ships:

- **Do not call the logged days a training history.** When you read `trainingDaysLogged`, add: "That count includes bench tests, so it is overstated."
- **Ask before you lean on any past day.** "Was <date> a real workout, or a test?"
- A goal's start value, a baseline or a progression read may rest on a test pull. Ask before the lifter accepts a number built on one.
- A session never ended is not a training day at all today. End every session (`04`).
- Do not try to fix history yourself. There is no tool for it, and a guest label would make "who lifted" untrue.

## The starting prescription

`profile.get_starting_prescription` seeds a new lifter or a new exercise. Every seed is a **suggestion**: offer it, take the answer, never re-apply it after a decline.

- The seeds are **low on purpose**. Under-dosing week 1 is free to correct; over-dosing leaves fatigue that carries forward. Do not round up.
- `assumesBeginner: true` means no tier was ever declared. Say so; do not present the seeds as personal.
- `setsPerExercise: "reported_minus_one"` is an instruction to ASK what they run per muscle now, then seed one set below it. It is not a number to guess.
- `rirTarget: null` at the beginner tier is correct. Beginners do not track reps in reserve.
- `reasons[]` carries one line per seed. Read them out.

## Pitfalls

- **Asking your own intake list** instead of `missing[]`.
- **Suggesting the break length.**
- **Reading the signal as a classification.** It is a ceiling.
- **Saying a lowered tier shrank a goal.** It did not; it set `tierProvisional`.
- **Counting session rows as days**, or counting test days as training.
- **Interpreting an injury, or programming around a cardiovascular flag.**
- **Rounding a seed up to look ambitious.**

## Cross-refs

- Where the tier stamps a goal: `09-goals-and-weekly-review.md`
- Warm-up rungs and progression gates: `03-workout-programming.md`
- The break question inside the Sunday script: `14-sittings.md`
