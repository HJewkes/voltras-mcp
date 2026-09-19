# Effort, reps in reserve, and failure sets

**When to read this.** You are about to say how hard a set was; OR a tool returned an RIR, an RPE, a `basis` or a `caveat`; OR the plan calls for a set to failure; OR the user asks "how many did I have left?"; OR you are about to call `rir_velocity.fit` or `rir_velocity.target`.

Verified 2026-09-19 against voltras-mcp main (#468, #471).

## The rule

**Until a lift has a trusted fitted profile, you state no RPE and no reps in reserve. Not from velocity loss, not from a general model, not from a table in your head.**

You state what was measured: reps, load, and velocity loss.

| Say                                                                          | Do not say                   |
| ---------------------------------------------------------------------------- | ---------------------------- |
| "8 reps at 120 lb. Velocity dropped 22% from your fastest rep to your last." | "That was about an RPE 8."   |
| "You hit the 20% stop line on rep 7."                                        | "You had 1 or 2 reps left."  |
| "`fatigue.verdict` reads slowing."                                           | "You were close to failure." |

Why: the evidence does not support reading effort off velocity loss. One study found velocity-loss-to-RIR agreement unacceptable at every load tested (Jukic et al. 2023). The wall follows the same rule since #471: the live fatigue card, the set rows and the session summary show a dash for effort, and the live alert reads "VL18% · stop at VL30%" with no "reps left" claim.

The lifter may tell you their own effort. That is their report, and you may repeat it as theirs: "You said you had two left."

## What "trusted" means

Three separate gates. All must hold before you state effort for a lift.

| Gate                 | Who set it                           | Test                                                                                                                                              |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A fit exists         | The server                           | `rir_velocity.fit` returns `fitted: true`                                                                                                         |
| The server trusts it | The server (#471)                    | The curve's own error, `model.rirErrorReps`, is **under 2 reps**. Then `vbt.rir` reads `confidence: high` on a `fitted` basis; otherwise `medium` |
| The owner trusts it  | The owner (gated roadmap, section 6) | One more **held-out** failure set, in a later week, that the curve predicts within **1.5 reps**                                                   |

A fit that exists is not yet a fit you may quote. Until the owner's gate passes for that lift, read a fitted number to the owner as a check on the model, never to the lifter as their effort.

## Reading `metrics.compute {pipeline: "vbt.rir"}`

It returns a per-rep estimate, the final rep as the headline, and three named confidence axes. It never returns a bare number.

| `basis`            | Meaning                                                                                                     | What you do                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `profile-estimate` | A general regression. No fitted curve for this lift. `caveat` is non-null. Model confidence is always `low` | **Do not state it as effort.** If you mention it at all, relay the `caveat` word for word. Leaving it out is fine |
| `fitted`           | The lifter's own curve, read with each rep's **mean** concentric velocity                                   | State it only when confidence reads `high` AND the owner's gate has passed for that lift                          |

Each rep also reports `inputDomain`: whether it sits inside the range the model was fitted over. Outside that range the number is an extrapolation. Say so or leave it out.

Its velocity loss is peak-based by contract. It will not equal `vbt.set`'s mean-based loss. Do not present the two as a disagreement.

`report.weekly` prints an RIR line only when its gate allows, labelled `fitted` or `general model, not a proximity-to-failure read`. Relay the label with the line.

On a `pull` exercise the velocity-loss watch is suppressed: peak velocity does not decay with fatigue on a ballistic pull. You get one `velocity_loss_watch_suppressed` event. Judge the set by load, range of motion and what the lifter reports.

## The RIR-velocity fit

```
rir_velocity.fit {exerciseId}
   → fitted, reason, model {…, r2, rirErrorReps}, qualification {sets, sessions, reps considered}
```

A set qualifies when **all** of these hold:

- It is a `working` set. A `probe`, `warmup` or `technique` set never qualifies.
- Its load sits at **70 to 90%** of the lifter's rep-based estimated 1RM for that lift. That is roughly a 5 to 12 rep load.
- It has **at least 4 reps**.
- Something says how many reps were left at the end. Today only one thing can: the server **harvested** the set as a failure from its rep record. A self-reported reps-in-reserve column exists in the store, but **no tool writes it yet**.

A fit needs: **3 qualifying sets, over 2 sessions, 12 reps in all, covering a spread of at least 3 reps in reserve**, with velocity rising as reps in reserve rise.

- A failed fit **deletes** any stored curve for that lift. It leaves no stale one.
- `reason` names what the fit stands on, or which minimum was unmet. Read it out.
- One session can never qualify. Say that after the first failure session; do not promise a fit.

The owner's chosen protocol is stricter than the server's floor: **4 to-failure sets per lift, over 2 sessions, at least 72 hours apart.**

### How a failure is harvested

Nobody declares a failure. The server reads it from the reps, after the set closes. A set is labelled `failure` when:

- it is a `working` set with 4 or more reps;
- the last rep's concentric velocity is at or below **70%** of the set's fastest non-first rep;
- the last **3 reps** do not speed up (5% noise is allowed);
- the last rep keeps most of its range of motion. A last rep that loses more than 35% of the set's median range reads as cut short.

A set that stalls **without** that slowing pattern is labelled `abort` and never counts. This is on purpose. A set cut short by pain looks like failure, and it yields a falsely fast last rep, which would tell a lifter they have reps left when they do not.

So a set meant as a failure anchor must be a real grind to a stop, with full range, and not a sudden quit. If the lifter stops for any reason other than "could not complete the rep", it is not an anchor. Say nothing to make it one.

`baselines.recalc {exerciseId, reharvest: true}` re-runs this labelling over stored sets. It is a back-fill. It never asks anyone to train to failure.

### `rir_velocity.target`

`rir_velocity.target {exerciseId, rir}` turns a reps-in-reserve prescription into this lifter's velocity target. With no curve it returns `velocityTargetMps: null` and a `caveat`; the server does not substitute a group curve. `withinFittedRange: false` means an extrapolation. It reads the stored curve and never re-fits, so run `rir_velocity.fit` first after new failure sets. `coaching.explain {topic: "live.rir_estimation", exerciseId, rir}` gives the same target with the sourced prose.

## Failure sets: the safe recipe

**Harvest, never prescribe.** The product does not ask anyone to train to failure for its own sake. The training benefit of true failure is trivial to nil. The failure sets in S1 and S3 exist because the **owner chose** to collect anchors for the fit. Outside that protocol, do not program failure.

Only on failure-safe cable lifts: **cable row, cable chest press, lat pulldown.** Never on overhead, spinal-loaded or single-leg movements. That rules out shoulder press, overhead tricep extension, squat and Romanian deadlift.

Before the set:

1. Weight Training mode, constant load. **No eccentric overload, no chains.** No isometric work (VW-274, open).
2. A load the lifter expects to fail at between 5 and 12 reps.
3. Verify the load with `device.get_state`.
4. `set.start {slot, setPurpose: "working", watch: {notifyOn: [...]}}`. Give the watch a threshold or intent, or the call is refused.
5. **Cues off.** `system.set_cues {cues: "off"}`, and leave `midSet` off. Do not call `system.speak` during the set. The mic is deaf while any line plays, and a spoken "stop" in that window is lost (VW-173, open).
6. Say before they start: "Keep a hand near the stop. Go until you cannot finish a rep with full range. If anything hurts, stop; that set will not count and that is fine."

During the set: **silence.**

After the set:

1. `set_ended` arrives. Read reps, load and velocity loss back. No effort number.
2. Ask one question: **"How many more reps did you have?"** For a true failure the answer is zero; a different answer is useful to know.
3. No tool stores that answer per set. Put it in the session check-in notes at the end: `session.checkin {answers: [...], notes: "Row set 3 at 120 lb: said 0 left. Press set 3 at 80 lb: said 1 left."}`.
4. **Do not celebrate.** A harvested failure is a measurement. No praise for reaching failure, no count of them, no encouragement to produce more.
5. Rest longer than usual before the next lift.

## Stop signals you may use

- `velocity_loss_exceeded` from a watch: an advisory cue. Thresholds by training goal: `strength` 20%, `hypertrophy` 30%, `power` 10%. It never stops the set.
- `fatigue.verdict`: `good`, `slowing`, `grinding`, `form-breakdown`. A range-of-motion or tempo alarm overrides a clean velocity reading into `form-breakdown`. That is the one signal that catches a cheat rep.
- `coaching.explain`: `live.stop_set_signal`, `live.velocity_loss_threshold`, `live.rir_estimation`. Keep the tier on anything you relay.

A beginner does not track reps in reserve at all (`rirTarget: null` in the starting prescription is correct).

## Pitfalls

- **Turning a velocity-loss percent into "reps left".**
- **Quoting a `profile-estimate` as effort.**
- **Quoting a `fitted` number before the held-out check has passed.**
- **Promising a fit after one session.**
- **Marking a failure set `probe`.** It will never qualify.
- **Talking during a failure set.**
- **Failure on shoulder press, squat or any overhead, spinal-loaded or single-leg lift.**
- **Praising failure.**

## Cross-refs

- The S1 and S3 outlines that use this recipe: `14-sittings.md`
- What to say after an ordinary set: `06-analytics-and-coaching.md`
- Watches and set purposes: `04-set-execution.md`
- Voice and the deaf-mic window: `08-channel-events-reference.md`
