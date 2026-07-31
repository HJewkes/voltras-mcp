# voltras-mcp

An MCP (Model Context Protocol) server that turns a Voltra digital-resistance trainer into
something Claude can drive: connect to the device, set the load, record sets and reps, run
analytics over the history, and coach you through a workout out loud. It also ships a local
web dashboard so you can watch the set happen on a screen instead of in a chat log.

Stdio transport only — one server process per Claude Code session.

- **[Requirements](#requirements)** — Node 22.5+, and (for real hardware) Bluetooth setup
- **[Quickstart](#quickstart)** — clone, build, register with Claude Code
- **[Your first workout](#your-first-workout)** — including a no-hardware path you can run right now
- **[The dashboard](#the-dashboard)** — two front ends, one sidecar
- **[Environment variables](#environment-variables)**
- **[Running more than one instance](#running-more-than-one-instance)** — the most common way to break it
- **[Tool catalog](#tool-catalog)** and **[Push events](docs/push-events.md)**
- **[Troubleshooting](#troubleshooting)**

---

## Requirements

**Node >= 22.5.0.** The store is built on `node:sqlite`, which does not exist in older
releases. This is newer than the default on most machines — check before you start:

```bash
node --version    # must be v22.5.0 or later
```

There is no automatic preflight check for this; on an older Node the server fails at
startup with a module-resolution error for `node:sqlite`, which is not an obvious message.

**For real hardware (macOS):**

- **Bluetooth permission.** The BLE adapter runs inside whatever process launched the
  server — normally your terminal app, or the Claude Code desktop app. macOS grants
  Bluetooth access per-app, so the first scan triggers a permission prompt attached to
  _that_ app. If you dismissed it, re-grant under **System Settings → Privacy & Security →
  Bluetooth**. Without it, `device.scan` returns no devices and gives no other clue.
- **Xcode Command Line Tools** (`xcode-select --install`). The real BLE path pulls
  `@stoprocent/noble` (an optional dependency of `@voltras/node-sdk`), which is a native
  module. It ships prebuilt macOS binaries, but those are tied to specific Node ABI
  versions — on a recent Node it falls back to compiling from source with `node-gyp`,
  which needs the Command Line Tools. Because it is an _optional_ dependency, a failed
  build does **not** fail `npm install`; you only find out later when connecting doesn't
  work.

**No hardware?** Set `VOLTRA_ADAPTER=mock` and skip both of the above. See
[without a device](#option-b-without-a-device).

**Claude Code** for the MCP client, and for the optional push-event stream, **v2.1.80 or
later** (see [push events](docs/push-events.md)).

---

## Quickstart

The package is **not published to npm**. Older instructions that say `npx voltras-mcp` do
not work — clone and build it.

```bash
git clone <this-repo> voltras-mcp
cd voltras-mcp

npm install              # ~1000 packages
npm run build            # tsc → dist/ (this produces the server binary)
npm run build:dashboard  # vite → dist/spa (this produces the web dashboard)
```

Both build steps matter. `npm run build` alone gives you a working MCP server whose
dashboard `/app` route serves only a "SPA not built" placeholder.

Register it with Claude Code, pointing at the built entry point:

```bash
claude mcp add voltras -- node "$PWD/dist/bin.js"
```

Then restart Claude Code. The `voltras` server's tools and resources should appear; ask
Claude to call `server.health` to confirm the connection end to end.

<details>
<summary>Alternative: register via <code>npm link</code></summary>

```bash
npm link                              # exposes the `voltras-mcp` bin globally
claude mcp add voltras -- voltras-mcp
```

Equivalent, but the absolute-path form above has fewer moving parts and survives
`npm link` being cleared by an unrelated global install.

</details>

To pass configuration, use `-e`:

```bash
claude mcp add voltras -e VOLTRA_ADAPTER=mock -e VMCP_CUES=on -- node "$PWD/dist/bin.js"
```

### Optional: the `voltra-pt` launcher

`scripts/voltra-pt` starts Claude Code with the experimental channel capability enabled
(so the server can push rep- and set-level events into the conversation instead of the
model polling for them) and prefills a personal-trainer prompt.

```bash
echo "alias lift='$PWD/scripts/voltra-pt'" >> ~/.zshrc && source ~/.zshrc

lift                                    # default PT prompt
lift "let's do a back day"              # custom starting prompt
lift --print "list my sessions today"   # non-interactive query
```

The script refuses to launch unless `voltras` is already registered with `claude mcp`.
Set `VOLTRA_PT_PROMPT` to change the default prompt without editing the script.

---

## Your first workout

### Option A: with a Voltra

Power the device on and wake its screen first — a sleeping unit doesn't advertise.

In Claude Code, the conversation looks roughly like this. You're asking in English; the
tool calls are what Claude issues underneath.

1. **"Find my Voltra."** → `device.scan` (default 10 s window), then `device.connect` with
   the id it found. `device.connect` binds the device to a _slot_ — `primary` for a single
   unit; `left` / `right` when you're running two.
2. **"Set it to 60 pounds, weight-training mode."** → `device.set_mode` +
   `device.set_weight`. Confirm on the device screen that the numbers match.
3. **"Start a session — I'm doing incline dumbbell press."** → `session.start`. Supply
   exactly one of `exerciseId` (validated against the exercise catalog — use
   `exercise.search` to find one) or `exerciseName` (free text). If you intend to attach a
   training plan later, start with `exerciseId`.
4. **"Starting my set — stop me at 8 reps."** → `set.start`, optionally with a `watch`
   block so the server auto-stops the set at 8 reps or on a velocity-loss threshold. Lift.
5. **"Done."** → `set.end`. This persists the set and every rep with its telemetry.
6. Repeat 4–5 per set. Rest timers: ask for one and Claude uses `timer.start`, which is
   non-blocking and fires an event when it elapses.
7. **"That's the workout."** → `session.end`. Any set left open is closed as partial.

Afterwards: `session.list` / `session.get` for history, `set.get` for one set's full rep
detail, `metrics.compute` for the analytics pipelines.

While all of that happens, keep the [dashboard](#the-dashboard) open in a browser.

### Option B: without a device

`VOLTRA_ADAPTER=mock` replaces BLE with an in-process device that streams synthetic
telemetry through the _same_ pipeline a real unit uses. The tool surface is identical
(plus `mock.configure` and `mock.inject_error`), so you can walk through the whole flow
above without hardware.

There are also two scripted drivers that boot a dashboard and animate a workout into it,
so you can see the UI working before you own a device:

```bash
npm run build && npm run build:dashboard

npm run dashboard:sim                   # port 7799 — scripted state, no MCP server, no SDK
node scripts/dashboard-mock-drive.mjs   # port 7724 — boots the real MCP server in mock
                                        # mode and drives it through real tool calls
```

Open `http://127.0.0.1:<port>/app` — and open it _before_ or _during_ the run: the
set-log accumulates client-side from live transitions, so a browser that connects after the
last set has nothing to show. `dashboard-sim` takes `PORT=` and `LOOP=1` (repeat forever);
`dashboard-mock-drive` takes `VMCP_DASHBOARD_PORT=`. Read each script's header comment for
the rest.

---

## The dashboard

The server starts a **read-only, loopback-only HTTP sidecar** alongside the MCP transport.
It binds `127.0.0.1` only and exposes no mutating routes.

| URL                                  | What it is                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `http://127.0.0.1:7723/app`          | **The dashboard.** The live workout view — current set, reps, tempo, rest timer. The sole surface; no flag needed. |
| `http://127.0.0.1:7723/api/snapshot` | The JSON it polls. Useful for debugging.                                                                           |

Add `?variant=live-dual` (or `?variant=live`) to pin the two-device (bilateral) or
single-device layout for testing; without it, the page picks the stage from live state.

The port defaults to **7723** and is set by `VMCP_DASHBOARD_PORT`; `off` (or `0`) disables
the sidecar entirely. If `dist/spa` was never built, `/app` serves a small "SPA not built"
placeholder instead of erroring — if you see that, run `npm run build:dashboard`.

`src/dashboard/README.md` documents the architecture: why a React Native component library
renders on the web here, the Vite aliasing that makes it build, and the `/api/snapshot`
contract.

---

## Environment variables

Everything is optional; the defaults are a working configuration.

| Var                       | Default                         | Allowed                                | Purpose                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOLTRA_ADAPTER`          | `node`                          | `node` \| `mock`                       | BLE adapter. `mock` uses an in-process device and adds the `mock.*` tools. Invalid values throw at startup.                                                                                                                                                                                                                                                                   |
| `VMCP_DB_PATH`            | `~/.voltras/vmcp.sqlite`        | absolute path                          | SQLite store. Parent directory is created if missing. See [running more than one instance](#running-more-than-one-instance).                                                                                                                                                                                                                                                  |
| `VMCP_DASHBOARD_PORT`     | `7723`                          | port number \| `off` \| `0`            | Dashboard sidecar port. `off` disables it. An unparseable value silently falls back to the default rather than failing.                                                                                                                                                                                                                                                       |
| `VMCP_LOG_LEVEL`          | `info`                          | `debug` \| `info` \| `warn` \| `error` | Log verbosity. All logs go to stderr — stdout is reserved for the MCP transport.                                                                                                                                                                                                                                                                                              |
| `VMCP_CUES`               | `off`                           | `off` \| `on`                          | Deterministic spoken coaching cues (set intros, "two reps left", set-complete) fired the instant the triggering event does, with no model round-trip. **macOS only** — routes through the built-in `say` binary; a no-op elsewhere. Off by default because cues are audible and will double up with model-generated speech unless the coaching prompt cedes those categories. |
| `VMCP_REST_TIMER`         | `off`                           | `off` \| `on`                          | When `on`, a natural set close auto-arms the passive `rest_status` push cycle. Never armed on a `session.end` cascade.                                                                                                                                                                                                                                                        |
| `VMCP_REP_SOURCE`         | `analytics`                     | `analytics` \| `firmware`              | Which rep pipeline the read boundary draws from. `firmware` is a dark flag pending a hardware cutover.                                                                                                                                                                                                                                                                        |
| `VMCP_REP_CORRECTIONS`    | `off`                           | `off` \| `on`                          | Movement-class-dependent rep-segmentation corrections. Dark until validated across movement classes — on an untested movement it can drop valid reps.                                                                                                                                                                                                                         |
| `VMCP_SLOT_BINDINGS_PATH` | `~/.voltras/slot-bindings.json` | absolute path                          | Where persisted device ↔ left/right side bindings live (see the `slot.*` tools).                                                                                                                                                                                                                                                                                              |
| `VMCP_DEBUG_BUFFER_SIZE`  | `256`                           | integer                                | Capacity of the in-memory diagnostic ring buffer behind `debug.recent_frames` / `debug.recent_events`.                                                                                                                                                                                                                                                                        |

`VOLTRA_ADAPTER`, `VMCP_REP_SOURCE`, `VMCP_REST_TIMER`, `VMCP_REP_CORRECTIONS`, and
`VMCP_CUES` throw synchronously at startup on an unrecognized value, so a typo surfaces
immediately rather than being silently ignored.

---

## Running more than one instance

Stdio is a single-client transport, so **every Claude Code session spawns its own
`voltras-mcp` process**. Two of them with default settings will collide in two places:

- **Port 7723.** The second sidecar fails to bind. The error names the port and suggests
  `VMCP_DASHBOARD_PORT`; the MCP server itself keeps working, you just lose that
  dashboard.
- **The SQLite file.** Both processes open `~/.voltras/vmcp.sqlite`. On open, the store
  runs a single write-lock probe, which rejects the newcomer _only if_ the incumbent
  happens to hold a write lock at that instant. Otherwise both succeed and their later
  concurrent writes fail. **This is a best-effort check, not a guarantee** — keeping one
  process per database path is the caller's responsibility.

So: give each parallel session a distinct `VMCP_DB_PATH` **and** `VMCP_DASHBOARD_PORT`.

```bash
claude mcp add voltras-b \
  -e VMCP_DB_PATH=/Users/you/.voltras/vmcp-b.sqlite \
  -e VMCP_DASHBOARD_PORT=7724 \
  -- node "$PWD/dist/bin.js"
```

---

## Startup latency

The server is connect-first: the transport is live immediately, and the BLE adapter and
SQLite store bootstrap behind it. During that window tool calls return a structured
`STARTING` error rather than blocking. Expect sub-second readiness in mock mode and
roughly one to two seconds in node mode while BLE comes up.

---

## Tool catalog

86 tools in mock mode; 84 with the real adapter (`mock.*` is registered only when
`VOLTRA_ADAPTER=mock`). Full names and schemas are discoverable from any MCP client —
ask Claude to list them, or run `tools/list` against the stdio transport.

| Namespace       | Count | What it covers                                                                                                                                                                   |
| --------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.*`      | 24    | Scan, connect, disconnect, read state, and every resistance setting — weight, mode, eccentric overload, chains, damper, band ceiling, assist, isokinetic, rowing, guided load.   |
| `plan.*`        | 17    | Training-plan hierarchy: programs → blocks → weeks → templates → exercises, plus `next_workout`, `complete_workout`, `suggest_progression`, and `attach_to_session`.             |
| `debug.*`       | 6     | Diagnostic ring buffers, rep-stream parity comparison, flight-recorder status, and the channel-delivery round-trip probe.                                                        |
| `slot.*`        | 5     | Bind, identify, swap, list, and unbind the device ↔ physical-side (left/right) mapping used for bilateral work.                                                                  |
| `session.*`     | 5     | `start`, `end`, `set_exercise`, `list`, `get`.                                                                                                                                   |
| `set.*`         | 4     | `start` (with the optional auto-stop `watch` block), `end`, `live_metrics`, `get`.                                                                                               |
| `timer.*`       | 3     | `start` (non-blocking, push-completed — preferred for rest), `wait` (blocking, singleton), `cancel`.                                                                             |
| `system.*`      | 6     | `speak` (macOS `say`), start/stop for the local voice listener — an in-process Silero VAD + whisper.cpp over the mic; no audio leaves the machine — plus the device write-lease. |
| `profile.*`     | 3     | Self-reported training background (get/set) and the derived tier signal.                                                                                                         |
| `exercise.*`    | 2     | Search and fetch from the exercise catalog.                                                                                                                                      |
| `isometric.*`   | 2     | Max-force and bilateral-imbalance assessment protocols.                                                                                                                          |
| `baselines.*`   | 2     | Per-exercise baseline confidence STATE (`get`, `recalc`) — never baseline values, which are recomputed from stored reps on demand.                                               |
| `mock.*`        | 2     | Configure the mock device / inject adapter errors. Registered only in mock mode.                                                                                                 |
| `bilateral.*`   | 1     | Apply mode + weight + eccentric + chains across multiple bound slots in one call.                                                                                                |
| `driftguard.*`  | 1     | `check` — is rep execution (tempo, ROM) comparable across two sessions of one exercise? Diagnostic read over the in-process gate every cross-session comparison must pass first. |
| `metrics.*`     | 1     | `compute` — runs an analytics pipeline over a session, a set, or a set-id array. Dispatches to `@voltras/workout-analytics`; no analytics logic is reimplemented here.           |
| `progression.*` | 1     | Progression history for one exercise.                                                                                                                                            |
| `server.*`      | 1     | `health` — build metadata, SDK and analytics versions, uptime, connection state. Good first call after registering.                                                              |

Some `device.*` tools are explicitly marked `@experimental` or `@deprecated` in their own
descriptions; prefer the consolidated setters (for example `device.configure_isokinetic`
over the five per-field isokinetic setters).

### Resources

| URI                       | Body                                               |
| ------------------------- | -------------------------------------------------- |
| `voltra://device/current` | Current device snapshot.                           |
| `voltra://session/active` | Active session snapshot, or `{ "active": false }`. |
| `voltra://set/active`     | Active set snapshot, or `{ "active": false }`.     |

Subscriptions are supported: the server emits `sendResourceUpdated` for the specific
resource whose state changed. Resources are polling-correct regardless, so the
notification is a hint, not a requirement.

### Push events

The server can push structured rep/set/timer/connection events straight into the
conversation, so a coaching flow doesn't have to poll. This needs a launch flag and is
worth reading about separately: **[docs/push-events.md](docs/push-events.md)**.

---

## Troubleshooting

**`device.scan` finds nothing.** Wake the device screen. Then check macOS Bluetooth
permission for the app that launched the server (terminal or Claude Code), under System
Settings → Privacy & Security → Bluetooth. Then confirm the native BLE module actually
built — it's an optional dependency, so a failed build is silent at install time.

**Tool calls return `STARTING`.** Bootstrap hasn't finished. Retry after a second.

**`/app` shows "SPA not built".** Run `npm run build:dashboard`.

**The dashboard is unreachable.** Another instance already holds port 7723, or
`VMCP_DASHBOARD_PORT` is `off`. Check stderr — the sidecar logs the URL it bound to.

**Nothing works and the error mentions `node:sqlite`.** Your Node is older than 22.5.0.

**No spoken cues.** `VMCP_CUES` defaults to `off`, and cues are macOS-only regardless.

---

## Development

```bash
npm test                 # vitest
npm run test:watch
npm run lint             # eslint
npm run typecheck        # tsc --noEmit, plus a separate pass over the dashboard SPA
npm run format           # prettier
npm run build            # server → dist/
npm run build:dashboard  # SPA → dist/spa
npm start                # node ./dist/bin.js
```

CI gates on lint + typecheck + test + build. A pre-commit hook runs lint-staged, typecheck,
and the tests related to staged files.

Repo-specific conventions live in `CLAUDE.md`; the dashboard's architecture is documented
in `src/dashboard/README.md`.

---

## Confidentiality

No protocol bytes, raw frame payloads, or proprietary command codes belong in tool I/O,
schemas, log lines, documentation, or commits. Only typed values from the SDK's public
surface cross the MCP boundary. ESLint enforces part of this by flagging `Buffer` access
inside handler functions.
