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

## Events

| Event                    | Fires when                                                                                               | Auto-stops the set?       |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| `rep_finalized`          | A rep boundary closes the prior rep. See [the timing quirk](#the-rep_finalized-timing-quirk).            | —                         |
| `set_started`            | `set.start` succeeds. Carries device config plus a previous-set summary for fatigue context.             | —                         |
| `set_ended`              | `set.end` succeeds. Carries the full rep array and VBT summary — no follow-up `set.get` needed.          | —                         |
| `set_ended_by_device`    | The user pressed Stop on the Voltra itself while a set was open.                                         | implicit (device stopped) |
| `connection_changed`     | Any connection-state transition. Disconnects include active-set context.                                 | —                         |
| `timer_complete`         | A `timer.start` duration elapses.                                                                        | —                         |
| `set_target_reached`     | A `rep_count_reached` trigger matches.                                                                   | optional, via `stopOn`    |
| `velocity_loss_exceeded` | A `velocity_loss_exceeded` trigger matches (baseline = highest peak concentric velocity seen so far).    | optional, via `stopOn`    |
| `idle_timeout`           | The `idle_timeout_ms` watchdog fires — no rep activity for the configured window.                        | optional, via `stopOn`    |
| `rest_status`            | Passive rest-period ticks, only when `VMCP_REST_TIMER=on` auto-arms the cycle at a natural set close.    | —                         |
| `voice_command_applied`  | The voice fast-path already changed the weight locally. See [the voice fast-path](#the-voice-fast-path). | —                         |
| `voice_command_rejected` | A spoken weight command was recognized but not applied; rides alongside a `voice_input`.                 | —                         |

This table covers the events a coaching flow is built around; it is not guaranteed
exhaustive. The authoritative list is the set of publish sites under `src/state/`.

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

### While a cue is speaking

`system.speak` and the automatic cue emitter duck the mic for the length of each cue.
Ducked is not deaf: safety phrases are still transcribed and still unload, so a "stop"
shouted over a cue fires the same `deterministic_stop_triggered` it would in silence
(VMCP-05.20). The wake phrase and weight commands are suppressed for that window —
repeat them once the cue ends.

A transcript made mostly of the words being spoken aloud is dropped as the machine
hearing itself. The trade that buys: a lifter shouting a safety word that also appears
in the cue text is dropped with the echo. No shipped cue template contains a safety
word. Full design and residual risk: [docs/vmcp-05.20-safety-during-cues.md](vmcp-05.20-safety-during-cues.md).

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
