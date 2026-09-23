# Rest periods

**When to read this.** The user just finished a set and is going to rest; OR you need to plan the rest cadence for a multi-set block; OR a second lifter is working in and you cannot afford to block; OR `timer.start` returned a `restBasis` you need to explain.

Rest is the longest phase of any workout. The skill's job is to **stay useful during it**: not lock the conversation, not leave the user hanging, not babysit when they want quiet, and not let a pre-armed set die.

## Tool inventory

| Tool                               | What it does                                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timer.start {label, durationMs?}` | Non-blocking. Returns `{timer_id}` at once; fires `timer_complete` on the channel with the label. `label` is required. Several can run at once. **The default.** Omit `durationMs` and it picks the rest for you and reports why in `restBasis` |
| `timer.wait {durationMs, label?}`  | Blocks until it returns or is cancelled. Up to 1 h. The return is your wake-up. One at a time process-wide; a second caller gets `BUSY`                                                                                                         |
| `timer.cancel {timer_id?}`         | Cancels that timer. With no id, cancels the in-flight `timer.wait` only. No-op success if nothing matches                                                                                                                                       |

## How long to rest: let `timer.start` choose

Call `timer.start {label}` with **no `durationMs`** and the server picks:

1. The plan's `restSec` for the session's current exercise, when the coach set one. It is never extended.
2. Else a default by training goal: **120 s or more for `strength`**, **90 to 120 s for `hypertrophy`**, or a named conservative default when the session has no plan or the plan names no training intent.
3. That default **extends** when the exercise's most recent set reached its velocity-loss stop threshold in FEWER reps than the set before it. Fewer reps to the threshold is a sign the last rest was too short.

`restBasis` says which: `source` is `explicit` (you gave `durationMs`), `explicit_plan`, `intent_default` or `intent_default_extended`, with `intent`, `prevRepsToThreshold`, `currRepsToThreshold` and `extensionSeconds`. Say it in a sentence: "Two and a half minutes. Your last set hit the stop line a rep earlier than the one before, so I added thirty seconds."

An explicit `durationMs` is never overridden. Use one when the lifter asks for a specific rest.

## `timer.start` vs `timer.wait`

**`timer.start`** returns immediately. The conversation continues. When the duration elapses a `timer_complete` event arrives with `timer_id` and `label`. Use it for anything over about 30 s, anything where the user may talk, any exercise switch, and always when a second lifter is working in.

**`timer.wait`** does not return until the duration elapses. While it runs you cannot speak, read `get_state`, react to a channel event, or hear the user. Use it only when the rest is short (under 2 min), same exercise, nothing to discuss, and you told the user you are going quiet. If push events never registered this session (see `01-discovery-and-connection.md`), `timer.wait` is the only rest timer that will wake you, so use it and keep it short. If the lease is taken from you during a wait, it rejects with `LEASE_LOST`.

Cancellation: the user says "skip the rest" or "I'm ready." `timer.cancel {timer_id}` for a push timer; `timer.cancel` bare for the blocking wait. Acknowledge before the next setter.

## `rest_status`: passive ticks, opt-in

The server can publish `rest_status` every 15 s after a natural set close, capped at 5 min, with `elapsed_seconds` and `final: true` on the last tick. It is armed **only when the server was launched with `VMCP_REST_TIMER=on`**, and never after a `session.end` cascade. Treat `rest_status` as a bonus if it shows up, not something to wait for.

The wall's live page now counts rest down after every set, from the same rule `timer.start` uses, so the lifter can see it without you.

## Pre-arming across a rest

The inactivity net closes a set with no activity at about 90 s. A longer `watch.inactivityTimeoutMs` is now honoured, up to 600 s (VW-164). So you have two honest patterns:

- **Arm late (the default).** Set the weight during rest, verify, and `set.start` when the user says they are about to go.
- **Pre-arm with a window.** `set.start {…, watch: {inactivityTimeoutMs: 240000}}` before a three-minute rest. Without the window the set dies at about 90 s and leaves a zero-rep set in the store.

Auto-arm is the net under both: if the lifter starts before you arm, the server opens the set, and you upgrade it (`04`).

## Recipes

### Recipe A — short same-exercise rest, quiet

```
← set_ended; coach in 2 sentences
"Going quiet for 90 seconds. Say the word if you want to go early."
timer.wait {durationMs: 90000, label: "rest before set 3"}
"Ninety. Same weight?"
device.get_state; set.start; "Go."
```

### Recipe B — long rest, user wants to talk

```
← set_ended; coach
timer.start {label: "rest after row set 3"}  → {timer_id, restBasis}     # let it choose; say why
talk; look up history (progression.get_for_exercise); plan the next exercise; pre-set weight and verify
← timer_complete timer_id label="rest after row set 3"
"Time. Ready?" → set.start on their word
```

### Recipe C — switching exercises during rest

```
← set_ended (last set of exercise A); coach
timer.start {label: "rest before triceps"}
session.set_exercise {exerciseId: <B>, slot}          # label BEFORE the lifter touches the handle
device.set_weight …; device.get_state
"Triceps is loaded at 40. Start whenever; I'll cue at 10."
← timer_complete
set.start {slot, setPurpose: "warmup", watch: …} when the user is at the handle
```

### Recipe D — second lifter working in

Never `timer.wait` here; it deafens you while the other person is lifting. `timer.start` for the resting lifter with their name in the label, and run the guest's sets under a lifter label. Do not end the owner's session for it.

```
← set_ended (owner)
timer.start {durationMs: 150000, label: "owner rest, curls"}
session.set_lifter {slot, lifter: 'Jordan'}
device.set_weight …; verify; set.start {slot, setPurpose: "working"}
… guest's set …
session.set_lifter {slot, lifter: null}
device.set_weight <owner's load>; verify
← timer_complete label="owner rest, curls" → "Your two and a half is up."
```

### Recipe E — the user drives the cadence

No timer at all. "Tell me when you're ready." Set the weight and verify while you wait. Arm on their word.

## Pitfalls

- **`timer.wait` blocks everything**, including the `<channel>` events you would otherwise coach from. Prefer `timer.start`.
- **`timer.start` needs a `label`.** Make it descriptive; it comes back in the event and is how you tell two timers apart.
- **Bare `timer.cancel` does not cancel `timer.start` timers.** Hold the ids.
- **1 h cap** on both timers.
- **Don't time a set with a timer.** Sets close on the device signal, `set.end`, or inactivity, never on elapsed time, and you cannot force-stop anyway.
- **A pre-armed set with no inactivity window dies at about 90 s.** Arm late, or ask for the window.
- **Don't speak over a rest you are listening through.** `system.speak` and the automatic cues now share one queue, so lines no longer collide, but every line still mutes the mic while it plays (`08`). Keep "rest is up" short.
- **Don't override `restBasis` silently.** If you give an explicit duration, that was your choice; say why.

## Cross-refs

- The set you are resting from, and arming rules: `04-set-execution.md`
- What to coach during rest: `06-analytics-and-coaching.md`
- `timer_complete` and `rest_status` payloads: `08-channel-events-reference.md`
- Loading the cable during rest: `02-setter-cascade-and-verification.md`
