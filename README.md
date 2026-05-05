# voltras-mcp

MCP (Model Context Protocol) server exposing Voltra device control, workout/session recording, history, and analytics to Claude Code. Stdio transport only; the binary is registered as `voltras-mcp` and launched via `npx voltras-mcp` (or via `claude mcp add`).

The server emits push events as `notifications/claude/channel` so Claude Code wakes the model inline on rep finalization, set lifecycle, timer completion, device disconnects, and trigger-DSL matches — no polling required. See [Push events](#push-events) for the full list.

## Quickstart — start a PT session

The launcher script in `scripts/voltra-pt` starts Claude Code with the experimental channels capability enabled and prefills a prompt that triggers a personal-trainer session:

```bash
# One-time: alias the launcher (zsh)
echo "alias lift='$PWD/scripts/voltra-pt'" >> ~/.zshrc
source ~/.zshrc

# Each workout
lift                                    # default PT prompt
lift "let's do a back day"              # custom starting prompt
lift --print "list my sessions today"   # non-interactive query
```

The script validates that voltras is registered with `claude mcp` before launching and passes any extra args straight through. Set `VOLTRA_PT_PROMPT` to change the default initial prompt without editing the script.

**Channels require Claude Code v2.1.80 or later.** The launcher passes `--dangerously-load-development-channels server:voltras` automatically — without that flag, the channel events are silently dropped at the host (the rest of the MCP still works, just polling-only).

## Setup

Requires Node >= 22.5.0 (the server uses `node:sqlite`).

```bash
# Register with Claude Code (uses npx; pulls the published package)
claude mcp add voltras -- npx voltras-mcp

# Local development (clone + link)
git clone <remote> ~/Documents/projects/voltras-mcp
cd ~/Documents/projects/voltras-mcp
npm install
npm run build
npm link
claude mcp add voltras -- voltras-mcp
```

Restart Claude Code after registration; resources and tools appear under the `voltras` MCP server. To use push events on top of the polling surface, launch with the channels flag (or the `voltra-pt` launcher above).

## Environment Variables

| Var              | Default                  | Allowed                                | Purpose                                                                             |
| ---------------- | ------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `VOLTRA_ADAPTER` | `node`                   | `node` \| `mock`                       | BLE adapter selection. `mock` adds the `mock.*` tools and uses an in-memory device. |
| `VMCP_DB_PATH`   | `~/.voltras/vmcp.sqlite` | absolute path                          | SQLite store location. The directory is created if missing.                         |
| `VMCP_LOG_LEVEL` | `info`                   | `debug` \| `info` \| `warn` \| `error` | Log verbosity. All logs go to stderr; stdio is reserved for the MCP transport.      |

## Concurrency

Stdio is a single-client transport. Each Claude Code session spawns its own `voltras-mcp` process. If two processes target the same `VMCP_DB_PATH`, the second detects SQLite write-lock contention at startup and exits with a clear error message naming the path. Use distinct `VMCP_DB_PATH` values when running multiple sessions in parallel.

## Startup Latency

Server is connect-first: `server.connect(transport)` returns immediately, after which the BLE adapter and SQLite store bootstrap. During the bootstrap window (~hundreds of ms), tool calls return a structured `STARTING` error result rather than blocking. Once bootstrap completes, real handlers replace the placeholders. Adapter init is the dominant cost; expect sub-second readiness in mock mode and 1-2 seconds in node mode while BLE comes up.

## Tool Catalog

26 tools across eight always-on namespaces plus an optional `mock.*` namespace (28 total).

### Device (`device.*`)

| Tool                   | Purpose                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| `device.scan`          | Discover nearby Voltra devices. Optional `timeoutMs` (default 10000, min 1000). |
| `device.connect`       | Connect to a discovered device by id.                                           |
| `device.disconnect`    | Disconnect from the active device.                                              |
| `device.set_weight`    | Set target weight (kg).                                                         |
| `device.set_mode`      | Set training mode.                                                              |
| `device.set_chains`    | Configure chain settings.                                                       |
| `device.set_eccentric` | Configure eccentric overload.                                                   |
| `device.get_state`     | Read current device snapshot from `LiveState`.                                  |

### Session + Query (`session.*`)

| Tool            | Purpose                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `session.start` | Begin a session. Provide exactly one of `exerciseId` (catalog-validated) or `exerciseName` (free-text). |
| `session.end`   | Finalize the active session (auto-closes any active set as `partial: true`).                            |
| `session.list`  | List persisted sessions. `sort` accepts `startedAt:desc` (default) or `startedAt:asc`.                  |
| `session.get`   | Fetch a single session by id, including its sets.                                                       |

### Set (`set.*`)

| Tool               | Purpose                                                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `set.start`        | Begin a set inside the active session. Optional `watch: { stopOn[], notifyOn[] }` registers triggers (`rep_count_reached`, `velocity_loss_exceeded`, `idle_timeout_ms`) that fire channel events and (for `stopOn`) auto-stop the set when matched. See [Push events](#push-events). |
| `set.end`          | End and persist the active set.                                                                                                                                                                                                                                                      |
| `set.live_metrics` | Read live metrics for the in-progress set from `LiveState`.                                                                                                                                                                                                                          |
| `set.get`          | Fetch a completed set's full payload (set metadata + every persisted rep with per-phase telemetry). Returns `SET_NOT_FOUND` for unknown ids.                                                                                                                                         |

### Analytics (`metrics.*`)

| Tool              | Purpose                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metrics.compute` | Run an analytics pipeline (`pipeline` enum) against a session id, set id, or set-id array. Dispatches to `@voltras/workout-analytics` — no analytics logic re-implemented locally. |

### Exercise (`exercise.*`)

| Tool              | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `exercise.search` | Search the workout-analytics catalog by name. |
| `exercise.get`    | Fetch a catalog `Exercise` by id.             |

### Timer (`timer.*`)

| Tool           | Purpose                                                                                                                                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `timer.start`  | Schedule a non-blocking timer. Returns a `timer_id` immediately and fires a `timer_complete` channel event when `durationMs` (1ms..1h) elapses. Multiple in-flight timers are allowed; each gets its own id. Cancel via `timer.cancel({ timer_id })`. **Preferred for rest periods** — the conversation isn't held open. |
| `timer.wait`   | Block for `durationMs`, then return. Useful for sync waits where channels aren't enabled. Singleton: a second `timer.wait` while one is active returns `BUSY`.                                                                                                                                                           |
| `timer.cancel` | Cancel the active `timer.wait` (no args) or a specific push timer (`timer_id`). No-op success when nothing matches.                                                                                                                                                                                                      |

### Server (`server.*`)

| Tool            | Purpose                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `server.health` | Returns server build metadata, SDK + analytics versions (best-effort), uptime, and current connection state. |

### Debug (`debug.*`)

| Tool                      | Purpose                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debug.recent_frames`     | Return the last N telemetry frames from an in-memory ring buffer (capacity 256, override via `VMCP_DEBUG_BUFFER_SIZE`).                                 |
| `debug.recent_events`     | Return the last N SDK events (rep_boundary, set_boundary, settings_update, connection_state_change).                                                    |
| `debug.push_test_channel` | Emit a synthetic `claude/channel` notification with caller-supplied `content` + `meta`. Used to smoke-test channel delivery without driving the device. |

### Mock (`mock.*`, registered iff `VOLTRA_ADAPTER=mock`)

| Tool                | Purpose                                             |
| ------------------- | --------------------------------------------------- |
| `mock.configure`    | Apply mock-device parameters (battery, RSSI, mode). |
| `mock.inject_error` | Inject an error condition for adapter-error tests.  |

## Resources

Three MCP resources are always registered:

| URI                       | Body                                               |
| ------------------------- | -------------------------------------------------- |
| `voltra://device/current` | Current device snapshot from `LiveState`.          |
| `voltra://session/active` | Active session snapshot, or `{ "active": false }`. |
| `voltra://set/active`     | Active set snapshot, or `{ "active": false }`.     |

`capabilities.resources.subscribe = true`. The server emits `sendResourceUpdated({ uri })` for the specific resource whose state changed (best-effort hint; resources are polling-correct regardless).

## Push events

The server declares the experimental `claude/channel` capability and pushes structured events as `notifications/claude/channel`. Each event arrives as a `<channel ...>{json}</channel>` tag in the live conversation when Claude Code is launched with `--dangerously-load-development-channels server:voltras` (or the `voltra-pt` launcher). When channels aren't enabled at session launch, the host silently drops them and the rest of the MCP keeps working over polling.

Payload shape: scalars on `meta` (XML attributes) for fast filtering; structured detail in `content` as a JSON-encoded object whose first key is always `summary` (a human-readable line so the model doesn't have to parse to know what happened).

| Event                    | Fires when                                                                                              | Auto-stop?                |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------- |
| `rep_finalized`          | Each ECC→CONC transition closes the prior rep (rep N "done" requires rep N+1 to start).                 | —                         |
| `set_started`            | `set.start` tool succeeds. Carries device config + previous-set summary for fatigue context.            | —                         |
| `set_ended`              | `set.end` tool succeeds. Carries the full rep array + VBT summary (skip `set.get` + `metrics.compute`). | —                         |
| `set_ended_by_device`    | User pressed Stop on the Voltra unit (out-of-grace `onSetBoundary` with active set).                    | implicit (device stopped) |
| `connection_changed`     | Any `onConnectionStateChange` transition. Disconnect events include active-set context.                 | —                         |
| `timer_complete`         | A `timer.start` duration elapses.                                                                       | —                         |
| `set_target_reached`     | `rep_count_reached` trigger from `set.start({ watch })` matches.                                        | optional via `stopOn`     |
| `velocity_loss_exceeded` | `velocity_loss_exceeded` trigger matches (baseline = highest peak concentric velocity seen so far).     | optional via `stopOn`     |
| `idle_timeout`           | `idle_timeout_ms` watchdog fires (no rep activity for the configured window).                           | optional via `stopOn`     |

### Trigger DSL

`set.start({ watch: { stopOn[], notifyOn[] } })` registers triggers evaluated server-side. `stopOn` matches auto-stop the set (firing the trigger event AND `set_ended` with `partial_reason: 'auto_stopped'` and `auto_stop_cause: <trigger.type>`); `notifyOn` matches just fire the trigger event with `auto_stopped: 'false'` so the model can decide. Triggers dedupe per (type, value) — registering the same spec twice fires once.

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

### UX quirk to know

`rep_finalized` fires when the _next_ rep begins, not when the current one ends — intrinsic to the analytics pipeline's ECC→CONC boundary detection. The terminal rep (rep N) never sees a closing transition; `set.end` finalizes it via `completeSet()` and the `set_ended` channel event covers that case. Coaching surfaces should treat each `rep_finalized` event as "user just started a new rep, here's the prior one's metrics."

## Privacy / NDA

No protocol bytes, raw frame payloads, or proprietary command codes appear in any tool I/O, schema, log line, or commit. Only typed values from the SDK public surface cross the MCP boundary.
