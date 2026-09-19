# Set execution

**When to read this.** The cable is loaded and the user is about to lift; OR you are switching exercises; OR a second person wants to work in; OR a `set_started {auto_armed: true}` just arrived; OR you need the set lifecycle, set purposes, watch config, the session check-in, or the isometric tools.

The MCP's set lifecycle is **label the session → start → reps arrive as channel events → end**. The agent's job inside the loop is small: get the label right, say why the set is performed, register advisory triggers, react to the few events worth a cue, and let the device close the set.

## Tool inventory

| Tool                                                                                            | What it does                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.start {exerciseId \| exerciseName, slot, lifter?, preSessionCarbs?, verboseIdleReps?}` | Open a session on a slot, pinned to an exercise. Returns `{sessionId}`. `SESSION_ALREADY_ACTIVE` if one is open on that slot; `EXERCISE_NOT_FOUND` for a bad id. Resets the mode-revert latch |
| `session.set_exercise {exerciseId \| exerciseName, slot}`                                       | Repoint the active session's exercise. Only sets started **after** this call inherit it. Publishes `session_exercise_changed`                                                                 |
| `session.set_lifter {slot, lifter}`                                                             | Name who is on the cable for the sets that follow. `{lifter: null}` when the owner is back                                                                                                    |
| `session.checkin {answers, notes?, slot?, sessionId?, preSessionCarbs?}`                        | Record a check-in against a session. Cadence and gating below                                                                                                                                 |
| `session.end {slot, checkin?}`                                                                  | Close the session; force-ends an open set, disengages the motor, clears the mode-revert latch. Takes the same `checkin` block                                                                 |
| `set.start {slot, setPurpose?, watch?, lifter?}`                                                | Engage the motor from slack and start recording, or UPGRADE an auto-armed set in place. Returns `{setId}`, plus `upgraded: true` and `adoptedReps` on an upgrade                              |
| `set.end {slot}`                                                                                | Finalize, persist reps, disengage, recalc the exercise baseline. `NO_ACTIVE_SET` if nothing is open                                                                                           |
| `set.live_metrics {slot}`                                                                       | The active set's rolling snapshot, or `{active: false}`                                                                                                                                       |
| `set.get {setId}`                                                                               | A persisted set with every rep. Post-hoc only. Carries `repCountDisagreement` when counts differ                                                                                              |
| `set.update {setId, lifter}`                                                                    | Relabel a stored set's lifter. Only the label is editable                                                                                                                                     |
| `isometric.measure_hold` / `measure_max` / `measure_imbalance`                                  | Isometric assessments. See the section below and its mount warning                                                                                                                            |
| `debug.compare_rep_streams {slot}`                                                              | Analytics rep count vs the device's rep count on the active set. Use when the live count and the lifter disagree                                                                              |

## Label the session before you record

A set gets its exercise from the session pointer **when the set starts**, and is never relabelled. Persisted sets without an exercise are invisible to goals, progression, baselines, `session.readiness` and per-exercise history. On 2026-09-19, 105 of 177 stored sets had none.

```
exercise.search {query: "cable row"} → [{id, name, …}]
session.start {exerciseId, slot}                 # first exercise, per slot you record on
… sets …
session.set_exercise {exerciseId: <next>, slot}  # BEFORE the lifter's first pull of the next exercise
… sets …
```

Rules:

- **Per slot.** A bilateral rig has two sessions; label both.
- **Id, not name.** `exerciseName` is stored as free text and a name-only switch into a session that already has an id-attributed exercise is rejected (`AMBIGUOUS_EXERCISE_SWITCH`) unless it matches the catalog exactly.
- **Before the pull, not before `set.start`.** With auto-arm on, the set can open on the lifter's own reps. It copies whatever exercise the session holds at that instant.
- **Mid-set is allowed but pointless.** The open set keeps its old label; only later sets change.
- **Guided load**: pass `exerciseId` / `exerciseName` to `device.start_guided_load`, or open the session first so the auto-set lands in it.

`preSessionCarbs {level: "low" | "normal" | "high", hoursSinceLastMeal?}` records a self-reported carb context. Pass it only if the lifter volunteers it. Absent means never reported. `report.weekly` lists it; nothing else reads it yet.

## Set lifecycle and the channel-event timeline

```
Time →

    device.set_weight, verify         ─→  header weight is what get_state shows NOW
    set.start {slot, setPurpose, watch}─→ {setId}; channel: set_started (carries previous_set_summary)
    user pulls rep 1
    user starts rep 2                 ─→  channel: rep_finalized rep_count=1   ← fires when the NEXT rep begins
    …
    rep N finalized                   ─→  channel: set_target_reached  [advisory]
    velocity drops past the threshold ─→  channel: velocity_loss_exceeded  [advisory]
    user lets go                      ─→  channel: rep_finalized for rep N, then set_ended closed_by=device
    OR set.end                        ─→  channel: rep_finalized for rep N, then set_ended closed_by=tool
    OR no activity                    ─→  channel: idle_timeout, then set_ended closed_by=inactivity_timeout
```

`rep_finalized` fires when the **next** rep begins, because a rep is only provably complete once the following one starts. Treat it as "the user just started a new rep; here are the previous one's numbers." The **final rep is published by the set close**, right before `set_ended`. The one exception is an inactivity close, which drops its trailing in-progress rep. Cues written the other way land one rep late.

`set_ended.meta.closed_by` is the discriminator: `device`, `tool`, `inactivity_timeout`, `disconnect`, `session_end`, `guided_load_exited`. There is no separate device-ended event; the generated push-events table still lists one, but nothing publishes it.

## Auto-armed sets

Auto-arm is **on by default** (`server.health.autoArm`). With a session open and no set armed, the server opens the set itself on the lifter's reps and publishes `set_started {auto_armed: true}`. It waits for a second rep, so a rope-positioning pull is not rep 1.

Such a set carries no watch, no stated purpose (it is a working set until you say otherwise), and only whatever exercise the session held.

**When you see `auto_armed: true`, call `set.start {slot, setPurpose, watch}` at once.** It upgrades that set in place: same id, same start time, same reps, the motor is not re-engaged. The result is `{setId, upgraded: true, adoptedReps}` and a `set_updated` event follows. It works **once per set**; a second `set.start` is a request for a new set and is refused.

If `idle_rep_reclaimed` arrives, reps you already heard about as idle now belong to the set. Resynchronize to its `idle_rep_count`. Nothing was lost.

You should still arm yourself when you can: set the weight, verify, `set.start`, then say "go." Auto-arm is the net, not the plan.

## Arming rules

1. Set the weight. Verify. **Then** `set.start`. **Then** tell the user to lift.
2. Do not set the weight after `set.start`: the set header snapshots weight at the start (VW-165) and the persisted set will carry the old number and fire `weight_implied_mismatch`.
3. The inactivity net is 90 s. A longer `watch.inactivityTimeoutMs` is honoured, up to 600 s (VW-164), so you may pre-arm before a long rest if you ask for the window. A shorter value tightens it. With no value, a set with no activity closes at about 90 s.
4. A `set.start` on a pre-extended cable does not engage the motor (VMCP-02.22). The lifter must let the cable go slack first, or you use guided load.

## Why the set is performed: `setPurpose`

| `setPurpose`        | Use it for                                | How it is read                                                                                                                                |
| ------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `working` (default) | Everything that counts                    | The only value scored against the rep band, the only one that sets the top load, and the only one that feeds baselines, goals and the RIR fit |
| `warmup`            | A ramp rung or a feeler                   | Excluded from progression and baselines; counted separately in the coach report                                                               |
| `probe`             | A deliberate heavy low-rep discovery rung | Excluded from scoring, so 3 reps at top load never reads as a missed 5 to 10 band and never drives a deload                                   |
| `technique`         | Light form work                           | Excluded likewise                                                                                                                             |

`isWarmup: true` is a deprecated alias for `setPurpose: "warmup"`. Passing both with different meanings is refused as `INVALID_INPUT`. **Pass `setPurpose` before the lifter moves whenever you can.**

Warm-up count is individualized: two for a small movement on a warm muscle, four or five for a big technical one, one feel set for a second exercise on an already-warm muscle. `plan.warmup_ramp` proposes the rungs (`03`).

A guided-load set takes `isWarmup` and `watch` on the `device.start_guided_load` call itself (`02`).

## Watch config: triggers and timeouts

```
set.start {
  slot: "left",
  setPurpose: "working",
  watch: {
    notifyOn: [
      {type: "rep_count_reached", value: 8},
      {type: "velocity_loss_exceeded", intent: "hypertrophy"}
    ],
    inactivityTimeoutMs: 45000
  }
}
```

| Trigger                                                     | Fires                                                                                 | Event                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------ |
| `{type: "rep_count_reached", value: N}`                     | after rep N finalizes, i.e. as rep N+1 begins                                         | `set_target_reached`     |
| `{type: "velocity_loss_exceeded", pct: P}` or `{…, intent}` | when the just-finalized rep's peak concentric velocity is that far below the baseline | `velocity_loss_exceeded` |

**Where the velocity-loss threshold comes from.** An explicit `pct`; OR an `intent` (`strength` 20%, `hypertrophy` 30%, `power` 10%); OR neither, in which case it comes from the planned exercise's `trainingIntent`. **With none of the three the call is refused**, rather than registering a watch that can never fire. The fired event says which of the three it used.

**The baseline** is the highest peak concentric velocity among the set's ELIGIBLE reps. A rep whose range or peak velocity sits far off the others is excluded, in either direction, so a positioning pull and a half-rep are both out. (This fixed the rope false positive the installed skill warned about.)

**Pulls.** On a `pull` exercise the velocity-loss watch is suppressed, because peak velocity does not decay with fatigue on a ballistic pull. You get one `velocity_loss_watch_suppressed` event at set start. Judge effort by load, range of motion and what the lifter reports. `watch: {velocityLoss: {force: true}}` re-enables it for that set.

**Triggers are advisory only.** They publish an event for you to coach from; they never stop the set. Force-stopping mid-rep damaged a cable on hardware (2026-05-11) and was removed. Say "I'll cue you at 8; let go when you're done," never "I'll stop you at 8."

**Do not turn a velocity-loss event into an effort claim.** "Twenty percent down" is a fact. "Two reps left" is not (`13`).

## Recipes

### Recipe — standard working set of 8

```
device.set_weight {slot, lbs: 70}; device.get_state {slot}
set.start {slot, setPurpose: "working", watch: {notifyOn: [{type: "rep_count_reached", value: 8}, {type: "velocity_loss_exceeded", intent: "hypertrophy"}]}}
"Seventy's on. Eight reps, let go when you're done."
← rep_finalized … ← set_target_reached → "That's eight. Let go when you're done."
← set_ended closed_by=device (rep_count, vbt_summary)
coach in 2 to 4 sentences from vbt_summary; see 06-analytics-and-coaching.md
```

### Recipe — the lifter started before you armed

```
← set_started auto_armed=true
set.start {slot, setPurpose: "working", watch: {…}}   → {setId, upgraded: true, adoptedReps: 3}
← set_updated
… carry on as normal …
```

### Recipe — bilateral set, both arms

```
bilateral.cascade …; get_state per slot
set.start {slot: "left", setPurpose, watch}; set.start {slot: "right", setPurpose, watch}
← rep_finalized meta.slot=left … meta.slot=right …
← set_ended slot=left; ← set_ended slot=right          (they close independently)
← bilateral_divergence if the rep counts differ
```

Two `setId`s, two sessions. Metrics run per set.

### Recipe — exercise change mid-session

```
set_ended of the last set
session.set_exercise {exerciseId: <new>, slot}        # per slot, BEFORE the lifter touches the handle
device.set_weight …; verify
set.start {slot, setPurpose: "warmup"}                 # feel set on the new movement
```

## Ending, and the session check-in

Always end the session. A session never ended does not count as a training day today (VW-489).

```
session.end {slot, checkin?: {answers: [{code, value}, …], notes?}}
```

`session.checkin` takes the same block at any time. `answers` needs at least one entry, at most eight.

| `code`                                    | Value                                                   |
| ----------------------------------------- | ------------------------------------------------------- |
| `went`, `felt`, `off`, `questions`        | Free text, up to 500 characters                         |
| `next`, `soreness`, `joint`, `motivation` | `low`, `medium` or `high`. Never a 5- or 10-point scale |

Rules:

- **Cadence**: after the very first session, then at the end of each completed training week. Never mandatory, never a gate on anything.
- **Show the lifter their own numbers first.** Loads, reps and sets are already recorded. Do not ask "how did it go" as a prompt; `went` exists to store what they volunteer.
- `soreness`, `joint` and `motivation` are **withheld until the lifter has a training day before today**. A withheld code you sent anyway comes back in `withheld`.
- A guest session writes nothing. Check-ins are the owner's only.
- `notes` (up to 2000 characters) is where a per-set "how many more reps did you have?" answer goes for now. No tool stores it per set (`13`).

This is separate from the Sunday weekly check-in (`profile.log_weekly_checkin`, `10`).

## Isometric assessments

**Mount warning (VW-274, open).** Isometric mode can pull up to 400 lb per unit whatever weight is set, and no mount rating is published. With no rating configured the result carries `mountLoadWarning`; with one configured, a hold above it is refused before it begins. **Do not plan an isometric max while the mount rating is unknown.** If the lifter asks for one, read the warning out first.

You set Isometric mode and a low weight first; these tools change no settings.

| Tool                                                                                                              | What it runs                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isometric.measure_hold {slot, side?, holdMs?, exerciseId?, setupAngleDeg?, strict?}`                             | ONE hold (default 5 s), returns at once. For a coach-paced assessment                                                                                                         |
| `isometric.measure_max {slot, durationMs?, trials?, restMs?, warmup?}`                                            | The full protocol: two submaximal warm-up pulls, then N trials (default 3 × 5 s) with **120 s** rest between every hold. Multi-minute; tell the user the whole protocol first |
| `isometric.measure_imbalance {primarySlot, secondarySlot, primarySide?, dominantSide?, testNonDominantFirst?, …}` | Both sides in sequence (default 120 s between), with the asymmetry read                                                                                                       |

How to read them:

- **Peak force is the headline.** `meanPeakForceLbs` is the mean of the best 2 valid trials. The per-trial `rfdLbPerS` and `impulseLbS` are diagnostic only, never for tracking change.
- **The inferred working weight is a heuristic, never a 1RM.** What a hold predicts depends on the joint angle it was held at. `jointAngleGate` reports `comparable`, `angle_mismatch` or `angle_unverified`.
- **There is no fixed asymmetry threshold.** (The installed skill's 10% and 15% lines are gone.) A difference is marked real only when it exceeds the lifter's own trial-to-trial spread on that test. Direction across tests (`directionHistory`) is the interpretable signal, not one magnitude.
- `setupComparability: "setup_confounded"` means the two sides were different physical setups. The left-versus-right reading is withheld; say why.
- **Never prescribe corrective single-limb work from an asymmetry.** The stated answer is consistent strength training over time.
- `changeFromBaseline.changed` is true only when the change exceeds the adjusted error threshold. `peakForceBaseline` is null under 3 past occasions.
- `isometric_phase` events (`ready`, `go`, `hold`, `stop`) and one `isometric_result` event ride the channel.

## Second lifter working in

Sets carry a `lifter` label (absent = owner). Tell the user before the guest lifts: "I'll tag your friend's sets so they stay out of your history."

```
session.set_lifter {slot, lifter: 'Jordan'}      # one call; later sets on this slot inherit it
   (the same exercise label stays; change it with session.set_exercise if the guest does something else)
… guest's sets, armed by set.start or by auto-arm; set.start {lifter} overrides per set …
session.set_lifter {slot, lifter: null}          # owner is back
```

If a set already ran under the wrong label: `set.update {setId, lifter: 'Jordan'}` (or `lifter: null` to reclaim it); the owner's baseline for that exercise is re-derived on the spot. To see a guest's history: `session.list {lifter: 'Jordan'}` or `progression.get_for_exercise {exerciseId, lifter: 'Jordan'}`; without `lifter` every read is owner-only.

What this buys: no baseline, failure-anchor, goal or progression pollution, one call per switch, and the guest's sets are findable later. What it does not do: a guest has no profile, tier, diet phase, check-in or plan.

## `set.live_metrics`: when (not) to use it

Returns the active set's snapshot or `{active: false}`. Channel events tell you everything you need in real time; reach for this only when the user asks "what rep am I on?" or you are on polling because push never registered.

## Pitfalls

- **Label before the pull.** With auto-arm on, a late label is a lost label.
- **Upgrade an auto-armed set once.** A second `set.start` is refused.
- **`set.start` on an active set you did not auto-arm returns `SET_ALREADY_ACTIVE`.** `set.end` first.
- **`set.start` while the device is in Rowing returns `ROWING_USE_TWO_STAGE`.**
- **`set.start` after a mode revert returns `SET_ABORTED_BY_MODE_REVERT`** and the motor does not engage. Recovery in `07-recovery-and-escalation.md`.
- **A velocity-loss watch with no `pct`, no `intent` and no planned intent is refused.**
- **Trailing in-progress reps are dropped on an inactivity close.**
- **Rep counts can disagree** between the live count, `set_ended.rep_count`, the device count and `reps.length`. `set.get` reports the split in `repCountDisagreement`. The device counts reps; report the split, do not pick a winner.
- **Bilateral sets have two `setId`s and two sessions.** Never assume `primary`.
- **A probe marked `working` reads as a missed set.** A failure anchor marked `probe` never qualifies for the fit (`13`).

## Cross-refs

- Cable setup and the mode rule: `02-setter-cascade-and-verification.md`
- Channel payloads: `08-channel-events-reference.md`
- Coaching from `vbt_summary` and the pipelines: `06-analytics-and-coaching.md`
- Effort claims and failure sets: `13-effort-rir-and-failure-sets.md`
- Rest after a set: `05-rest-periods.md`
- Mode-revert latch, lease, disconnect: `07-recovery-and-escalation.md`
