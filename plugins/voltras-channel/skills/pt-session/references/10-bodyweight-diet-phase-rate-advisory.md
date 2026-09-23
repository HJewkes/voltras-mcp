# Bodyweight, diet phase, the weekly check-in and the rate advisory

**When to read this.** The user gives you a weight; OR names or changes a diet phase; OR it is Sunday and the check-in is due; OR `goal.weekly_review` returned an advisory, a veto or a proposal; OR a block boundary returned `recompReAsk`; OR the user asks how much to eat.

Verified 2026-09-19 against voltras-mcp main.

## Who owns what

Two coaching systems touch the body. The split is already in the code, and the owner's merge review (`sources/design/2026-09-19-health-workout-merge-review.md`) keeps it.

| Owner                 | What                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| **The health system** | Calorie and macro sizing, meals, diet adherence, and the weigh-in log                   |
| **This coach**        | Training, effort, lift goals, and _observing_ the bodyweight rate against the goal line |

So:

- **You prescribe no calories, no macros and no step counts.** The server refuses to size them, and a test fails on any such figure. If the user asks how much to eat, name the health coach.
- **Bodyweight is copied, never measured twice.** Until a shared record exists, `profile.log_bodyweight` takes the health log's value for that date, with that reading's own time. It never records a separate reading. This is an interim rule that depends on you following it.
- The merge review recommends one Sunday coach over both systems. That is an owner decision, not yet made. Until it is, stay on your side of the table above.

## Tools

| Tool                                                                                                                                     | What it does                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile.log_bodyweight {bodyweightLbs, measuredAt?, note?, leannessBand?, waistIn?, bodyFatPct?, bodyFatSource?, measurementProtocol?}` | Stores one reading. Storage only: no trend, rate or verdict. The same `measuredAt` again UPDATES that reading and REPLACES every optional field      |
| `profile.get_body_metrics {sinceDays?}`                                                                                                  | Readings newest first, the 7-day mean, and the leanness, waist and body-fat series                                                                   |
| `profile.set_diet_phase {phase, startedAt?, recompMode?}`                                                                                | The only writer of the phase. Returns the declared range and the whole timeline                                                                      |
| `profile.log_weekly_checkin {hunger?, dietPlanAdherence?, sleepQuality?, weekOf?}`                                                       | The Sunday check-in. Three optional low / medium / high ratings                                                                                      |
| `profile.get_weekly_checkin {weekOf?}`                                                                                                   | One week's check-in. `checkin: null` differs from a check-in with blank fields                                                                       |
| `goal.weekly_review {weekOf?, response?}`                                                                                                | The Sunday bodyweight-rate review against the committed goal line                                                                                    |
| `profile.respond_recomp_advisory {response}`                                                                                             | Answers the recomposition re-ask from a block boundary                                                                                               |
| `coaching.explain {topic: "diet.rate_autoregulation"}`                                                                                   | The sourced prose behind the rate rules. Also `diet.phase_coupling`, `diet.phase_durations`, `diet.disruption_handling`, `meso.diet_phase_tolerance` |

## Logging a weight

Ask: **"What does your health log show for this morning's weight?"**

```
profile.log_bodyweight {bodyweightLbs: <the health log's number>,
                        measuredAt: <that reading's time>,
                        note: "copied from the health log"}
```

- **Never ask for leanness fields, and never ask anyone to go and get measured.** Log what they volunteer and nothing more.
- `leannessBand` (`high`, `moderate`, `lean`, `very-lean`) is their own visual read. Never infer it from a photo, a weight or a percentage.
- `waistIn` is a raw trend. Never convert it to a body-fat percentage.
- `bodyFatPct` needs `bodyFatSource`. It is stored for **display only**. Read it as a display value, never as evidence for a training decision.
- A correction: the same `measuredAt`, the whole reading restated.

What you may say about the series:

- The 7-day mean appears only with at least 3 readings in the last 7 days. It is context, not a verdict.
- Two body-fat readings from the same source give a change with a band. A change inside the band is **"no measurable change"**; never read it as a direction. Two readings from different sources give a reason, not a comparison. Read the reason.
- A rate needs about two weeks of weigh-ins. With fewer, `goal.weekly_review` sets `lowConfidence`. Say so.

## The diet phase

Ask: **"Which diet phase are you actually in right now: fat loss, gain, maintenance, or recomposition? And when did it start?"**

- This is the **observed** phase: what they are actually eating. It is a different claim from the `phaseType` on a plan week, and this tool never touches that.
- A recomposition REQUIRES `recompMode`. Ask: **"Hold your weight, or a slow deliberate loss?"** Never infer it from the scale. For any other phase `recompMode` is refused.
- Declaring a phase closes the previous one at the same instant. A `startedAt` in the past rewrites the timeline from there forward. That is the supported way to fix a late or wrong entry.
- Read the returned timeline back, oldest first.

What the phase changes:

| Reader                              | Effect                                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A bodyweight goal's band            | See the table below. It is the phase at **derivation**, and acceptance fixes it                                                                                      |
| `plan.suggest_progression`          | Fat loss widens the rep shortfall tolerated before a back-off, more with each week in phase. Gain tightens it. Relay the clause in `reasoning`, never the bare delta |
| `metrics.compute session.readiness` | A dip the phase explains reads `zoneVerdict: "tolerated"`                                                                                                            |
| `metrics.compute history.trend`     | A flat run the phase explains reads `plateau.verdict: "tolerated"`                                                                                                   |
| `goal.declare_priorities`           | In fat loss, a specialized item draws the downgrade offer (relay it, never apply it)                                                                                 |
| A guest lifter                      | Always reads an unknown phase. The declaration is about the owner's eating                                                                                           |

Maintenance, and no declared phase, leave every threshold where it was.

### Bodyweight goal bands by phase

The tool's own numbers win. These are what to expect.

| Phase                                   | Committed edge                                         | Stretch edge      |
| --------------------------------------- | ------------------------------------------------------ | ----------------- |
| Fat loss                                | minus 0.5% a week                                      | minus 1% a week   |
| Gain                                    | plus 0.25% a week                                      | plus 0.5% a week  |
| Maintenance, or recomposition on `hold` | a corridor of plus or minus 2% around the start weight | the same corridor |
| Recomposition on `slow-loss`            | hold the start weight (0% a week)                      | minus 0.5% a week |
| **No phase declared**                   | the maintenance corridor, silently                     |                   |

The last row is the trap. **Declare the phase before you declare a bodyweight priority.**

The slow-loss band is an owner-chosen default from 2026-09-19. The source corpus states no recomposition rate. Say that if asked where it comes from.

Status words for a bodyweight goal:

- A maintenance or hold goal reads `behind` when the weight leaves its corridor on either side. `corridorSide` says `above` or `below`.
- A slow-loss goal is judged against its own band: a flat week reads on track, a gaining week reads behind.
- A band starts at the goal's own start weight, on week 1 of its block. It does not follow the lifter.
- The start value is the mean of the readings in the last 30 days, or the single reading when there is one. With none, the target is `skipped`.
- Advice for any bodyweight goal that is behind names intake and activity. It never names load and reps.

## The Sunday weekly check-in

One question, all three parts optional: **"Quick check-in for the week: hunger, how closely you followed your eating plan, and sleep. Low, medium or high for each, or skip any."**

```
profile.log_weekly_checkin {hunger?, dietPlanAdherence?, sleepQuality?}
```

- Anchored to the week (`weekOf`, default the most recent Sunday), not to any session.
- **Call it even when they skip all three.** A blank check-in is stored, and it differs from none: with no answers the rate advisory falls back to the scale alone.
- A second call for the same week acts as a correction.
- `hunger` is the lever-choice input. It tells the advisory whether an unexpected rate looks like an intake problem or an activity one.
- `dietPlanAdherence` corroborates hunger. It drives nothing alone.
- `sleepQuality` is a **confounder line only**. Read it beside a rate observation. It never triggers a change.

This is separate from `session.checkin`, which belongs to a workout (`04`).

## The rate advisory: `goal.weekly_review`

Order on a Sunday:

```
profile.log_bodyweight {…}          # today's reading, copied from the health log, if there is one
profile.log_weekly_checkin {…}
goal.weekly_review                  # weekOf defaults to the most recent Sunday
```

It returns `observation`, `advisory`, `levers`, `vetoes`, `offCadenceConditions`, `confounders`, `lowConfidence`, `checkin`, `readingCount`, `targetId`, `committedValue`, `stretchValue`, `committedUnchanged`, `outcome`, `proposal`, `suppressedByDecline`, `reviewedAt`, `notes`, `recalibrationOffers`.

`outcome` tells you what kind of week it was: `advisory`, `vetoed`, `within_band`, `awaiting_cadence`, `below_half_week_floor`, `flagged_for_review`, `no_rate_to_autoregulate`, `unevaluable`. Say the matching plain sentence. Do not add advice the tool did not give.

How to relay it:

1. **The observation, as read.** "You moved minus 0.4 percent this week against a band of minus 0.5 to minus 1."
2. **A veto, by name.** Four exist. Each one means nothing is proposed.

   | Veto                       | Plain words                                                                                                                                |
   | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
   | `settling`                 | Still inside the 2-week settling window after a phase change. Water and glycogen are still moving                                          |
   | `noise_floor`              | The week moved less than half a pound. That is noise                                                                                       |
   | `spike_in_window`          | A single-day jump in the last 7 days is still down-weighted. Wait for the weight to settle                                                 |
   | `salt_and_sweetener_creep` | Flat or slightly up late in a cut, with adherence reported high. Ask about salt and diet-drink creep before reading it as stalled fat loss |

   Each veto carries its own `reason`. Read that out. Do not add your own suggestion on top of a veto.

3. **The advisory is never sized.** It names two levers, **intake and activity**, and says the pick is the lifter's. No calories, no macros, no steps.
4. **Sleep is a confounder line only.**
5. **A proposal gets an answer.** Ask, then `goal.weekly_review {weekOf, response: "accepted" | "declined" | "ignored"}`. A declined proposal is never raised again for the same week at the same urgency. It can return next week, or sooner if the signal widens.
6. **Nothing on the chart moves.** Committed and stretch are read, never written. The phase is never written here. A phase change is `profile.set_diet_phase`, on their word.
7. **Recalibration offers** ride along. Raise each once (`09`).

Reviews run on a weekly cadence, with a two-week cap. A review of a past week reads the series as of that week.

## The recomposition re-ask

`plan.complete_workout` and `plan.next_workout` return `blockBoundary.recompReAsk` at every block boundary. `proposal` is null unless the lifter is in a declared recomposition AND one of three things is true: the phase reached its second block boundary, the cumulative loss since the phase started reached 7% (noticeable) or 10% (significant), or the self-reported leanness band moved a rung toward lean. When `proposal` is null, `silentReason` says why.

- The proposal offers a switch to fat loss or gain, or keeping the recomposition on its declared mode.
- Relay it. Then `profile.respond_recomp_advisory {response: "accepted" | "declined"}`.
- **Neither answer changes the phase.** Call `profile.set_diet_phase` only if they ask for the switch.
- It returns at every boundary from the second one until answered. Answering is what closes it.
- Call `respond_recomp_advisory` only when a proposal is actually open.

## Pitfalls

- **A bodyweight priority before the phase is declared.** The corridor is fixed on acceptance.
- **A second, independent weigh-in.** Copy the health log.
- **Reading a change inside its band as a direction.**
- **Sizing anything.** Not calories, not a deficit, not steps.
- **Treating sleep as a trigger.**
- **Stacking your own advice on a veto.**
- **Writing bodyweight or diet detail into workspace notes or tasks.** It is personal data. Keep it in the store and the health system.

## Cross-refs

- Goal declaration, acceptance and the fixed-target rule: `09-goals-and-weekly-review.md`
- Block boundaries and the planning brief's `dietPhase`: `11-dated-blocks-and-planning-sitting.md`
- The Sunday script: `14-sittings.md`
