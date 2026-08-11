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

| Event                    | Fires when                                                                                            | Auto-stops the set?       |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------- |
| `rep_finalized`          | A rep boundary closes the prior rep. See [the timing quirk](#the-rep_finalized-timing-quirk).         | —                         |
| `set_started`            | `set.start` succeeds. Carries device config plus a previous-set summary for fatigue context.          | —                         |
| `set_ended`              | `set.end` succeeds. Carries the full rep array and VBT summary — no follow-up `set.get` needed.       | —                         |
| `set_ended_by_device`    | The user pressed Stop on the Voltra itself while a set was open.                                      | implicit (device stopped) |
| `connection_changed`     | Any connection-state transition. Disconnects include active-set context.                              | —                         |
| `timer_complete`         | A `timer.start` duration elapses.                                                                     | —                         |
| `set_target_reached`     | A `rep_count_reached` trigger matches.                                                                | optional, via `stopOn`    |
| `velocity_loss_exceeded` | A `velocity_loss_exceeded` trigger matches (baseline = highest peak concentric velocity seen so far). | optional, via `stopOn`    |
| `idle_timeout`           | The `idle_timeout_ms` watchdog fires — no rep activity for the configured window.                     | optional, via `stopOn`    |
| `rest_status`            | Passive rest-period ticks, only when `VMCP_REST_TIMER=on` auto-arms the cycle at a natural set close. | —                         |

This table covers the events a coaching flow is built around; it is not guaranteed
exhaustive. The authoritative list is the set of publish sites under `src/state/`.

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
