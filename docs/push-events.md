# Push events

By default an MCP client learns what happened by calling tools. That's a poor fit for
coaching: the interesting moments (a rep finished, the set hit its target, rest is over)
happen while nobody is asking.

voltras-mcp declares the experimental `claude/channel` capability and pushes structured
events as `notifications/claude/channel`. Each event arrives in the live conversation as a
`<channel ...>{json}</channel>` tag, so the model wakes on it inline.

## Enabling them

Push events require **Claude Code v2.1.80 or later**, launched with a `--channels` entry
naming this server. There are two ways to get one accepted:

```
--channels plugin:voltras-channel@voltras-local        # allowlisted plugin (default)
--dangerously-load-development-channels server:voltras # development fallback
```

`scripts/voltra-pt` passes the first for you, and the second under `VOLTRA_PT_DEV=1`. The
plugin route needs a one-time install plus a machine-wide allowlist entry; both are
covered in [channel-plugin-packaging.md](channel-plugin-packaging.md). A bare
`server:<name>` entry can never be allowlisted, which is why the packaging exists.

**Without an accepted entry the host silently drops the events** — there is no error; the
rest of the MCP just keeps working over polling.

To check delivery end to end: call `debug.push_test_channel`, read the `nonce` off the
`<channel>` tag that arrives, and echo it back with `debug.confirm_channel`.
`server.health` then reports `channelsLastConfirmedAt`, and `matchedProbe: true` proves
channels are live.

## Payload shape

Scalars go on `meta` (rendered as XML attributes, so they're cheap to filter on);
structured detail goes in `content` as a JSON object whose first key is always `summary` —
a human-readable line, so the model knows what happened without parsing the rest.

Every event carries a `slot` meta key naming which slot fired it: `primary` for
single-device flows, `left` / `right` when two units are connected. Coaching surfaces
filter on `slot` to keep parallel rep streams apart.

Slot-scoped events (anything sent through `channels.forSlot(slotId).publish(...)`) also
carry an `at` meta key: an ISO-8601 UTC timestamp of when the server emitted the push,
distinct from any event-specific `started_at` / `ended_at` a payload already carries.

## Events

| Event                            | Fires when                                                                                                                                                                                      | Auto-stops the set?       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `rep_finalized`                  | A rep boundary closes the prior rep. See [the timing quirk](#the-rep_finalized-timing-quirk).                                                                                                   | —                         |
| `set_started`                    | `set.start` succeeds, or the server auto-arms on the lifter's own reps (`auto_armed: true`).                                                                                                    | —                         |
| `set_updated`                    | `set.start` upgraded an auto-armed set in place (`upgraded: true`). See [auto-armed sets](#auto-armed-sets).                                                                                    | —                         |
| `set_ended`                      | `set.end` succeeds. Carries the full rep array and VBT summary — no follow-up `set.get` needed.                                                                                                 | —                         |
| `set_ended_by_device`            | The user pressed Stop on the Voltra itself while a set was open.                                                                                                                                | implicit (device stopped) |
| `connection_changed`             | Any connection-state transition. Disconnects include active-set context.                                                                                                                        | —                         |
| `timer_complete`                 | A `timer.start` duration elapses.                                                                                                                                                               | —                         |
| `set_target_reached`             | A `rep_count_reached` trigger matches.                                                                                                                                                          | optional, via `stopOn`    |
| `velocity_loss_exceeded`         | A `velocity_loss_exceeded` trigger matches. See [the baseline](#which-reps-set-the-velocity-baseline).                                                                                          | optional, via `stopOn`    |
| `velocity_loss_watch_suppressed` | At set start, a registered `velocity_loss_exceeded` trigger will never fire because the set's movement class makes the signal invalid. See [the movement-class gate](#the-movement-class-gate). | —                         |
| `idle_timeout`                   | The `idle_timeout_ms` watchdog fires — no rep activity for the configured window.                                                                                                               | optional, via `stopOn`    |
| `rest_status`                    | Passive rest-period ticks, only when `VMCP_REST_TIMER=on` auto-arms the cycle at a natural set close.                                                                                           | —                         |
| `idle_rep_reclaimed`             | An auto-armed set adopted reps a previous idle report already counted. See [auto-armed sets](#auto-armed-sets).                                                                                 | —                         |
| `voice_command_applied`          | The voice fast-path already changed the weight locally. See [the voice fast-path](#the-voice-fast-path).                                                                                        | —                         |
| `voice_command_rejected`         | A spoken weight command was recognized but not applied; rides alongside a `voice_input`.                                                                                                        | —                         |

This table covers the events a coaching flow is built around; it is not guaranteed
exhaustive. The authoritative list is the set of publish sites under `src/state/`.

## The `device_set_summary` block on `set_ended`

When the device closes the set itself, `set_ended` carries a `device_set_summary`
block holding the firmware's own numbers for the set, alongside everything the
server derived from telemetry:

```jsonc
{
  "device_set_summary": {
    "rep_count": 7, // the raw frame count, verbatim; meta.device_rep_count is reconciled
    "rep_duration_ms": 5730, // a SET-level aggregate despite the name — not a per-rep figure
    "target_weight_tenths": 200,
    "schema_version": 1,
    "peak_force_lbs": 88.6,
    "peak_power_raw": 412,
  },
}
```

`peak_force_lbs` and `peak_power_raw` are present only when the frame carried them,
and both are cross-checks rather than replacements for the analytics pipeline's own
peaks:

- `peak_force_lbs` is corroborated across nine archived capture sessions but is not
  vendor-confirmed.
- `peak_power_raw` has **unverified units**. It scales with rep speed the way power
  should, but its magnitude has never been checked against an instrumented
  reference, so it may be watts, centiwatts or another scaling. Treat it as a
  relative quantity and do not present it to the lifter as watts.

Both are persisted on the stored set as `firmwarePeakForceLbs` and
`firmwarePeakPower`, so `set.get` and `session.get` return them too.

## The voice fast-path

`system.listen_start` acts on two classes of utterance without a model turn. Safety
phrases (stop, unload, cut the weight, …) unload every connected slot and publish
`deterministic_stop_triggered`. Weight commands change the load and publish
`voice_command_applied`.

Recognized weight cues, wake phrase optional:

- absolute — "set it to 70", "set to 70", "70 pounds", "go to 65", "put it at 55",
  "weight 45", "make it 60", spelled-out numbers ("seventy", "a hundred and ten",
  "one-thirty"). A bare number is a command only at 20 lb and above, so counting reps
  aloud cannot write a weight.
- relative — "up 10", "add five", "bump it 5", "go up ten", "down 10", "drop 5",
  "take off ten", plus "lighter" / "heavier" for a 5 lb step.
- cancel — "cancel", "never mind", "undo that". One deep per slot, reverting to the
  weight held before that slot's last local command.
- slot targeting — an explicit "left" / "right" wins; otherwise the slot that most
  recently had a set (active beats finished), or the only connected one.

`voice_command_applied` means **the write already happened**: do not call
`device.set_weight` for it. `previous_lbs` is what "cancel" would restore, and
`clamped` is `true` when a relative step ran into the 5-200 lb bound.

`voice_command_rejected` carries a `reason` and is always published together with the
ordinary `voice_input`, so the model can still act on the request:

| Reason                   | Meaning                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `ambiguous_slot`         | Two slots connected, no active set, no side word spoken.    |
| `slot_not_connected`     | The named side has no connected device.                     |
| `no_connected_slot`      | Nothing is connected.                                       |
| `out_of_range`           | An absolute target outside 5-200 lb (refused, not clamped). |
| `unknown_current_weight` | A relative step with no reported weight to step from.       |
| `nothing_to_undo`        | No local voice change on that slot to revert.               |
| `set_failed`             | The device rejected the write; `detail` carries the error.  |
| `no_weight_context`      | The fast-path is not wired in this server build.            |

Conversation about weight ("how much should I use", "that was seventy pounds last
time", "don't set it to 70") never reaches the fast-path — it routes to `voice_input`
as before.

## The trigger DSL

`set.start({ watch: { stopOn[], notifyOn[] } })` registers triggers the server evaluates
itself, so a stop condition doesn't depend on the model noticing in time.

- A `stopOn` match auto-stops the set: it fires the trigger event _and_ `set_ended`, with
  `partial_reason: 'auto_stopped'` and `auto_stop_cause` naming the trigger type.
- A `notifyOn` match only fires the trigger event, with `auto_stopped: 'false'` — the model
  decides what to do.
- Triggers dedupe per `(type, value)`, so registering the same spec twice fires once.

```jsonc
// Stop at 8 reps, warn at 25% velocity loss, auto-stop after 30s of inactivity
{
  "watch": {
    "stopOn": [
      { "type": "rep_count_reached", "value": 8 },
      { "type": "idle_timeout_ms", "value": 30000 },
    ],
    "notifyOn": [{ "type": "velocity_loss_exceeded", "pct": 25 }],
  },
}
```

## Auto-armed sets

Reps begin within about a second of a weight change on the unit, while a `set.start`
needs a model turn plus a tool round-trip. So with a session open and no set armed, the
server opens the set itself on the lifter's reps and publishes `set_started` with
`auto_armed: true`.

Such a set carries no watch, no stated purpose, and only whatever exercise the session held.
Call `set.start {setPurpose, watch}` as soon as you see the event: it UPGRADES that set in
place rather than failing with `SET_ALREADY_ACTIVE`. The set keeps its id, start time and
reps, the motor is not re-engaged, and the result is `{setId, upgraded: true, adoptedReps}`.
A `set_updated` event follows, carrying the new purpose and watch state. It works once per
set; a second `set.start` is a request for a new set and is refused as before.

The arm waits for a second rep before it fires. The rope-positioning pull that opens many
sets — a metre of cable, fast, unloaded — looks exactly like a rep, and one rep says
nothing about itself. When the two reps agree both are adopted and nothing is lost; when
they disagree only the later one is, and the pull stays in the idle ledger where
`idle_rep_summary` reports it.

Because the arm waits, a rep it later adopts may already have been reported as idle. Idle
reps are batched into one `idle_rep_summary` every 5s, and a pause longer than that window
between the two reps flushes the first one before the second arrives. When the summary is
still pending the adopted rep quietly leaves the batch and you never hear about it; when it
has already gone out, `idle_rep_reclaimed` follows:

```jsonc
{
  "summary": "1 idle rep already reported as idle now belongs to set 3f2a1b04 (auto-armed). Session total idle: 0.",
  "idle_rep_reclaimed": { "count": 1, "set_id": "3f2a1b04-…", "slot": "primary" },
  "idle_rep_count": 0,
}
```

Subtract `count` from the idle total you accumulated for this session, or just resynchronize
to `idle_rep_count` (the session-monotonic total after the reclaim). The reps themselves are
not lost — they are the opening reps of `set_id`. In verbose mode
(`session.start {verboseIdleReps: true}`), where each idle rep went out as its own
`idle_rep`, this is the only correction you get.

## Who is lifting (`lifter`)

`set_started` and `set_ended` carry a `lifter` key — in `meta` and in the `set` block —
ONLY when someone other than the owner performed the set. Its absence means the owner, so
a consumer reads "no key" as "the usual person" without a second lookup. On `set_started`
the `set` block always carries the field, `null` for the owner; the `meta` key is omitted
entirely in that case, because `meta` values are strings and `"null"` reads as a name.

The label comes from `session.set_lifter {slot, lifter}` (or `session.start {lifter}`) and
is snapshotted when the set starts, so relabelling mid-set never reattributes reps already
performed. An auto-armed set inherits it too — the reps a guest starts before anyone can
call a tool are still the guest's — and a `set.start {lifter}` on that set rewrites the
label as part of the upgrade.

A labelled set contributes nothing to the owner's baselines, failure anchors, progression
or session history. To relabel a set that already ran under the wrong name, call
`set.update {setId, lifter}`.

## Why a set was performed (`set_purpose`)

`set_started` and `set_updated` carry `set_purpose` in `meta` and in the `set` block:
`working`, `warmup`, `probe` or `technique`, stated by `set.start` and defaulting to
`working`. Only `working` is scored against a planned rep band, so a heavy 3-rep `probe`
never reads as a missed set and never drives a deload.

The older `is_warmup` boolean rides alongside it for one more release — `true` exactly
when `set_purpose` is `warmup`. Read `set_purpose`; a consumer still reading `is_warmup`
keeps working until it is removed.

## Which reps set the velocity baseline

The `velocity_loss_exceeded` baseline is the highest peak concentric velocity among the
set's ELIGIBLE reps. A rep is ineligible when its concentric ROM or its peak velocity sits
far off the median of the other reps in the set — in either direction, so an oversized
positioning pull and a half-rep partial are both excluded. With nothing to compare against
(a one-rep window), nothing is excluded.

`set_ended`'s `vbt_summary` takes `first_rep_v`, `peak_rep_v` and `mean_velocity` from the
same window, and so does `metrics.compute {pipeline: 'vbt.rir'}`, so the trigger, the
summary and the RIR estimate always agree about which reps were work. `last_rep_v` is
always the set's actual final rep: a short or slow last rep is the fatigue signal itself.

## The movement-class gate

`set_started` and `velocity_loss_exceeded` both carry a `movement_class` meta key: the
catalog `movementPattern` of the set's exercise (`push`, `pull`, `isolation`, `squat`,
`hinge`, `rotation`), or `unknown` when the set carries no identified exercise. It is
snapshotted at set start alongside `exercise_id` and never re-read mid-set.

On a `pull` set the `velocity_loss_exceeded` trigger does not fire. Peak concentric
velocity does not decay with fatigue on a ballistic pull — a 2026-07-05 cable-row capture
held 1.8-2.4 m/s across 50/80/115 lb with the highest peak on the LAST rep, while the same
lifter's chest press decayed 40% and predicted failure exactly. The figure is invalid there,
not merely noisy, so the set publishes one `velocity_loss_watch_suppressed` event at start
rather than going quiet for its whole duration:

```jsonc
{
  "suppression": {
    "reason": "ballistic_pull",
    "movement_class": "pull",
    "suppressed_thresholds_pct": [25],
    "override": "watch.velocityLoss.force",
  },
}
```

Judge effort on a pull by load, full-ROM failure and RPE. Pass
`watch: { velocityLoss: { force: true } }` at `set.start` to re-enable the trigger for one
set; the configured `pct` still decides when it fires. No threshold changes either way, and
every other movement class — including `unknown` — behaves exactly as before.

The same gate applies to `plan.suggest_progression`: a pull session never triggers the 25%
velocity-loss hold, and its `gates.effort` reads `unknown` rather than a verdict the signal
cannot support.

## The `rep_finalized` timing quirk

`rep_finalized` fires when the _next_ rep begins, not when the current one ends. That's
intrinsic to how the analytics pipeline detects rep boundaries — a rep is only provably
complete once the following one starts.

Consequences:

- The final rep of a set never sees a closing transition. `set.end` finalizes it, and the
  `set_ended` event covers it.
- Treat each `rep_finalized` as _"the user just started a new rep; here are the previous
  one's metrics"_, not as "the user just finished a rep". Cues written the other way land
  one rep late.

If you want cues that don't depend on the model reacting to these events at all, see
`VMCP_CUES` in the [main README](../README.md#environment-variables). Both cue switches are
runtime-togglable via `system.set_cues` and reported by `server.health`.
