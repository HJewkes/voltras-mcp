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

On an older Node the server fails at startup with a module-resolution error for
`node:sqlite`, which is not an obvious message. `scripts/voltra-pt` checks the version
before it launches; nothing else does. See [docs/bench-preflight.md](docs/bench-preflight.md).

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

Set `VOLTRA_PT_PROMPT` to change the default prompt without editing the script.

Before launching, it runs the bench pre-flight: it rebuilds the whisper binary if `npm ci`
wiped it, then prints one line per gate that would otherwise fail silently mid-session
(voice, Node version, push channel, spoken cues, dashboard port). Blockers exit non-zero;
everything else is advisory. `VOLTRA_PT_SKIP_PREFLIGHT=1` skips it. Details in
[docs/bench-preflight.md](docs/bench-preflight.md).

By default the script runs the server as the **`voltras-channel` plugin** and passes
`--channels plugin:voltras-channel@voltras-local`, which avoids the
`--dangerously-load-development-channels` warning dialog. That needs a one-time install:

```bash
claude plugin marketplace add "$PWD"     # an absolute path; "." is rejected
claude plugin install voltras-channel@voltras-local
echo "$PWD" > ~/.voltras/mcp-home        # tells the plugin where this checkout is
```

plus a machine-wide managed-settings file that allowlists the plugin — see
**[docs/channel-plugin-packaging.md](docs/channel-plugin-packaging.md)** for that file and
the reasoning behind the packaging.

The plugin ships the MCP server itself, so don't also register `voltras` with
`claude mcp add`: two processes would collide on the database and the dashboard port. The
script checks for this and refuses to launch.

Set `VOLTRA_PT_DEV=1` to fall back to the old path — a `claude mcp add`ed `voltras` server
plus `--dangerously-load-development-channels`. Use it if the managed-settings file isn't
installed.

---

## Launching

There is one launcher script for the server, regardless of how you invoke it:
`plugins/voltras-channel/bin/voltras-mcp-launch.sh`. It builds the dashboard SPA when
missing or stale, sources `.launch.env` from the repo root when present, then execs the
built server. `scripts/voltra-pt` and the `justfile` recipes below both call it — nothing
duplicates its resolution or build logic.

### `.launch.env`

Copy `.launch.env.example` to `.launch.env` (gitignored) to set defaults for every launch
without exporting them in your shell:

```bash
cp .launch.env.example .launch.env
```

### `just` recipes

`just` is optional — each recipe is a one-line wrapper you can run directly instead:

| Recipe           | Plain command                                                |
| ---------------- | ------------------------------------------------------------ |
| `just build`     | `npm run build`                                              |
| `just dashboard` | `npm run build:dashboard`                                    |
| `just test`      | `npm test`                                                   |
| `just typecheck` | `npm run typecheck`                                          |
| `just lint`      | `npm run lint`                                               |
| `just sim`       | mock adapter + dashboard on an OS-assigned port, isolated DB |
| `just bench`     | `node scripts/preflight.mjs`, then the plugin launcher       |

### Registering directly via `~/.claude.json`

To point Claude Code at the plugin's launcher script without installing it as a plugin
(no push events this way — see the caveat below), add it to the `mcpServers` map in
`~/.claude.json`:

```json
"voltras": {
  "command": "/absolute/path/to/voltras-mcp/plugins/voltras-channel/bin/voltras-mcp-launch.sh",
  "env": { "VOLTRAS_MCP_HOME": "/absolute/path/to/voltras-mcp" }
}
```

This is described here rather than performed for you — edit your own `~/.claude.json`.
A `server:<name>` entry registered this way can never be allowlisted for the experimental
push channel, so events fall back to polling. For push events (and the reinstall step
after pulling script changes), install it as the `voltras-channel` plugin instead — see
**[docs/channel-plugin-packaging.md](docs/channel-plugin-packaging.md)**.

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
   The set's header weight tracks the unit until the first rep closes, so arming before
   you dial the weight in still logs the weight you lifted. After rep 1 it is frozen: a
   weight written mid-set is the firmware's own no-op — it does not apply while the cable
   is under tension — so the header would otherwise name a load nobody lifted.
5. **"Done."** → `set.end`. This persists the set and every rep with its telemetry.
6. Repeat 4–5 per set. Rest timers: ask for one and Claude uses `timer.start`, which is
   non-blocking and fires an event when it elapses.
7. **"That's the workout."** → `session.end`. Any set left open is closed as partial.

**Someone working in?** → `session.set_lifter {lifter: 'Jordan'}` before they lift, and
`session.set_lifter {lifter: null}` when you take the rig back. Their sets are recorded in
full but contribute nothing to your baselines, failure anchors, progression or session
history. If a set already ran under the wrong name, `set.update {setId, lifter}` moves it
and re-derives your baseline for that exercise.

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
the sidecar entirely. If the port is already held (another session's server got there
first), the sidecar binds an OS-assigned port instead of giving up — so **read the URL
from `server.health`'s `dashboardUrl`** rather than assuming 7723. `/` redirects to
`/app`. If `dist/spa` was never built, `/app` serves a small "SPA not built" placeholder
instead of erroring — if you see that, run `npm run build:dashboard`.

`src/dashboard/README.md` documents the architecture: why a React Native component library
renders on the web here, the Vite aliasing that makes it build, and the `/api/snapshot`
contract.

---

## Environment variables

Everything is optional; the defaults are a working configuration.

| Var                            | Default                           | Allowed                                | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | --------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOLTRA_ADAPTER`               | `node`                            | `node` \| `mock`                       | BLE adapter. `mock` uses an in-process device and adds the `mock.*` tools. Invalid values throw at startup.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `VMCP_DB_PATH`                 | `~/.voltras/vmcp.sqlite`          | absolute path                          | SQLite store. Parent directory is created if missing. See [running more than one instance](#running-more-than-one-instance).                                                                                                                                                                                                                                                                                                                                                                                                    |
| `VMCP_DASHBOARD_PORT`          | `7723`                            | port number \| `off` \| `0`            | Dashboard sidecar port. `off` disables it. An unparseable value silently falls back to the default rather than failing. A port already in use falls back to an OS-assigned one — `server.health`'s `dashboardUrl` always names the port actually bound.                                                                                                                                                                                                                                                                         |
| `VMCP_LOG_LEVEL`               | `info`                            | `debug` \| `info` \| `warn` \| `error` | Log verbosity. All logs go to stderr — stdout is reserved for the MCP transport.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `VMCP_CUES`                    | `off`                             | `off` \| `on`                          | Deterministic spoken coaching cues (set intros, "two reps left", set-complete) fired the instant the triggering event does, with no model round-trip. **macOS only** — routes through the built-in `say` binary; a no-op elsewhere. Off by default because cues are audible and will double up with model-generated speech unless the coaching prompt cedes those categories. STARTUP DEFAULT ONLY — `system.set_cues` flips it at runtime and `server.health` reports the live value.                                          |
| `VMCP_CUES_MIDSET`             | `off`                             | `off` \| `on`                          | Whether the two cue categories that fire while the lifter is still under load (`target_hit`, `slowdown`) may speak. Off by default: every cue mutes the mic for its duration, so the ungated voice "stop" path is unavailable for that window, and mid-set is the worst place for that blind spot. Also a startup default only — see `system.set_cues`.                                                                                                                                                                         |
| `VMCP_REST_TIMER`              | `off`                             | `off` \| `on`                          | When `on`, a natural set close auto-arms the passive `rest_status` push cycle. Never armed on a `session.end` cascade.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `VMCP_AUTO_ARM`                | `on`                              | `off` \| `on`                          | When `on`, reps detected while a session is open (and no set is) open a set on the server's own initiative and count into it. Reps begin within ~1s of a weight change on the unit, so the gap before a `set.start` lands costs real reps. The arm waits for a second rep to corroborate the first, because a rope-positioning pull looks exactly like a rep until another rep disagrees with it (VW-181); when the two agree both are adopted. `off` restores idle-rep reporting only. `server.health` reports the live value. |
| `VMCP_REP_SOURCE`              | `analytics`                       | `analytics` \| `firmware`              | Which rep pipeline the read boundary draws from. `firmware` is a dark flag pending a hardware cutover.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `VMCP_REP_CORRECTIONS`         | `off`                             | `off` \| `on`                          | Movement-class-dependent rep-segmentation corrections. Dark until validated across movement classes — on an untested movement it can drop valid reps.                                                                                                                                                                                                                                                                                                                                                                           |
| `VMCP_SLOT_BINDINGS_PATH`      | `~/.voltras/slot-bindings.json`   | absolute path                          | Where persisted device ↔ left/right side bindings live (see the `slot.*` tools).                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `VMCP_DEBUG_BUFFER_SIZE`       | `256`                             | integer                                | Capacity of the in-memory diagnostic ring buffer behind `debug.recent_frames` / `debug.recent_events`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `VMCP_TRUECOACH_USERNAME`      | _unset_                           | email                                  | TrueCoach account email. See [TrueCoach (read-only pull)](#truecoach-read-only-pull).                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `VMCP_TRUECOACH_PASSWORD`      | _unset_                           | string                                 | TrueCoach password, in plaintext in the environment. Prefer `VMCP_TRUECOACH_PASSWORD_CMD`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `VMCP_TRUECOACH_PASSWORD_CMD`  | _unset_                           | shell command                          | A command whose stdout is the password, so the secret can stay in the macOS keychain. Wins over `VMCP_TRUECOACH_PASSWORD` when both are set.                                                                                                                                                                                                                                                                                                                                                                                    |
| `VMCP_TRUECOACH_CLIENT_ID`     | token response `user_id`          | string                                 | Override for the TrueCoach client id. Set it if the pull 404s with the id taken from the grant.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `VMCP_TRUECOACH_TOKEN_PATH`    | `~/.voltras/truecoach-token.json` | absolute path                          | Cached access token, written mode 0600. Never logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `VMCP_TRUECOACH_CACHE_DIR`     | `~/.voltras/truecoach-cache`      | absolute path                          | Raw response cache, 6-hour TTL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `VMCP_TRUECOACH_OUTBOX`        | `off`                             | `off` \| `on`                          | When `on`, `session.end` writes the session's rendered coach results to the outbox (see [Coach results and the outbox](#coach-results-and-the-outbox)). Local file only — nothing is uploaded. A session with no working sets writes nothing, and a failed write never fails the close. Invalid values throw at startup.                                                                                                                                                                                                        |
| `VMCP_TRUECOACH_OUTBOX_DIR`    | `~/.voltras/truecoach-outbox`     | absolute path                          | Outbox root. `pending/` under it is created on demand, mode 0700.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `VMCP_TRUECOACH_SUBMIT_ON_END` | `off`                             | `off` \| `on`                          | When `on` (and the outbox is on), writing an entry also spawns `tools/truecoach-submit --submit --session <id>` once, detached. Read the gates in [TrueCoach write-back (unattended, gated)](#truecoach-write-back-unattended-gated) first. Invalid values throw at startup.                                                                                                                                                                                                                                                    |

`VOLTRA_ADAPTER`, `VMCP_REP_SOURCE`, `VMCP_REST_TIMER`, `VMCP_REP_CORRECTIONS`,
`VMCP_AUTO_ARM`, `VMCP_TRUECOACH_OUTBOX`, `VMCP_TRUECOACH_SUBMIT_ON_END`, and `VMCP_CUES` throw synchronously at startup on an unrecognized value, so a typo surfaces
immediately rather than being silently ignored.

---

## Running more than one instance

Stdio is a single-client transport, so **every Claude Code session spawns its own
`voltras-mcp` process**. Two of them with default settings will collide in two places:

- **Port 7723.** The second sidecar can't bind it, so it falls back to an OS-assigned
  port and logs both. The MCP server itself keeps working; ask `server.health` which URL
  belongs to this session, or pin one with `VMCP_DASHBOARD_PORT`.
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

97 tools in mock mode; 95 with the real adapter (`mock.*` is registered only when
`VOLTRA_ADAPTER=mock`). "Load" means at least three different things across this
catalog — see [docs/vocabulary.md](docs/vocabulary.md) for the settings / mode /
engagement / lifecycle layers before reading too much into any one of them. Full names
and schemas are discoverable from any MCP client —
ask Claude to list them, or run `tools/list` against the stdio transport.

| Namespace       | Count | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.*`      | 24    | Scan, connect, disconnect, read state, and every resistance setting — weight, mode, eccentric overload, chains, damper, band ceiling, assist, isokinetic, rowing, guided load.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `plan.*`        | 18    | Training-plan hierarchy: programs → blocks → weeks → templates → exercises, plus `next_workout`, `complete_workout`, `suggest_progression`, `attach_to_session`, and `warmup_ramp` (read-only RP warm-up rungs). `template.create` / `exercise.create` also return advisory `warnings[]` — tier-aware RP volume ceilings. Suggestions: the write always succeeds. `suggest_progression`'s load increment is a fixed +5 lb step; a cited percent-of-load rule (VMCP-06.09 / B23) will replace it once a source states a number, reported back as `basis: 'percent' \| 'fixed'`. `next_workout` / `complete_workout` also return `blockBoundary` (VMCP-06.06 / B48) — `null` except right at a block edge, where it names the finished block and the next one and carries an advisory prompt to keep or restate the goal on file; the goal itself is never written by either tool. `exercise.create` also takes an optional `targetTempo` coach override (VW-46) — `{ ecc, pauseBottom, con, pauseTop }` seconds — that wins over the exercise/movement-pattern default in the live prescription. |
| `debug.*`       | 6     | Diagnostic ring buffers, rep-stream parity comparison, flight-recorder status, and the channel-delivery round-trip probe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `slot.*`        | 5     | Bind, identify, swap, list, and unbind the device ↔ physical-side (left/right) mapping used for bilateral work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session.*`     | 6     | `start`, `end`, `set_exercise`, `set_lifter` (name a guest working in, or `null` to hand the rig back), `list`, `get`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `set.*`         | 5     | `start` (with `setPurpose` — `working` / `warmup` / `probe` / `technique` — and the optional `watch` block), `end`, `live_metrics`, `update` (retro-tag a stored set's lifter), `get`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `timer.*`       | 3     | `start` (non-blocking, push-completed — preferred for rest), `wait` (blocking, singleton), `cancel`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `system.*`      | 7     | `speak` (macOS `say`), start/stop for the local voice listener — an in-process Silero VAD + whisper.cpp over the mic; no audio leaves the machine — plus `set_cues` (runtime cue toggles) and the device write-lease.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `profile.*`     | 5     | Self-reported training background (get/set), the derived tier signal, `get_starting_prescription` — conservative tier-seeded sessions/week, sets/exercise and RIR target — and `get_onboarding_gaps`. Advisory: they apply nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `exercise.*`    | 2     | Search and fetch from the exercise catalog.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `isometric.*`   | 3     | `measure_hold` — ONE hold, returns immediately, pushes `isometric_phase` (`ready` / `go` / `hold` / `stop`) so a coach can pace the assessment hold by hold. Plus the max-force and bilateral-imbalance protocols, which loop that same hold N times with the protocol rests and block until they finish.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `baselines.*`   | 2     | Per-exercise baseline confidence STATE (`get`, `recalc`) — never baseline values, which are recomputed from stored reps on demand.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mock.*`        | 2     | Configure the mock device / inject adapter errors. Registered only in mock mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `bilateral.*`   | 1     | Apply mode + weight + eccentric + chains across multiple bound slots in one call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `driftguard.*`  | 1     | `check` — is rep execution (tempo, ROM) comparable across two sessions of one exercise? Diagnostic read over the in-process gate every cross-session comparison must pass first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `metrics.*`     | 1     | `compute` — runs an analytics pipeline over a session, a set, or a set-id array, including `strength.e1rm` (VW-142) — Epley/profile/hybrid 1RM estimates from `{ load, reps }`, `{ exerciseId }`, or both — and `history.trend` (VW-144/VW-145) — per-exercise `{ series, trend, plateau }` over a weekly-bucketed window via WA's `buildTimeSeries`/`analyzeTrend`/`detectPlateau`, `plateau.phase` always `'unknown'` pending diet-phase tagging (VW-149). A weekly-volume/muscle-group companion pipeline is not wired yet: `@voltras/workout-analytics@2.2.0`'s published root does not re-export `getWeeklySummaries`/`getVolumeByMuscleGroup`; it follows once that package republishes with them public. Dispatches to `@voltras/workout-analytics`; no analytics logic is reimplemented here.                                                                                                                                                                                                                                                                              |
| `progression.*` | 1     | Progression history for one exercise, optionally filtered to one `side` (VMCP-04.09) — omitted adds a `sideSplit` per-arm summary instead.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mrvguard.*`    | 1     | `check` — diagnostic read over the maximum-recoverable-volume guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `coaching.*`    | 1     | `explain` — RP-derived coaching knowledge by topic, always tier-qualified and cited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `server.*`      | 1     | `health` — build metadata, SDK and analytics versions, uptime, connection state. Good first call after registering.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `truecoach.*`   | 1     | `import_week` — read-only pull of coach-assigned programming into `plan.*`. Off unless credentials are set; see [TrueCoach (read-only pull)](#truecoach-read-only-pull).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `report.*`      | 1     | `session_results` — per-exercise free-text result strings for one ended session, in the idiom a coach reads; see [Coach results and the outbox](#coach-results-and-the-outbox).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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

## TrueCoach (read-only pull)

`truecoach.import_week` pulls the coach-assigned workouts for a date range out of a
TrueCoach account and upserts them into the local `plan.*` tree. It is **off unless you
configure it**, it **only runs when you call it** (no timer, no startup hook, no
background sync), and it **never writes to TrueCoach** — the only non-GET request it can
make is the OAuth password grant.

### Setup

```bash
# Put the password in the macOS keychain once:
security add-generic-password -a "$USER" -s truecoach -w

export VMCP_TRUECOACH_USERNAME='you@example.com'
export VMCP_TRUECOACH_PASSWORD_CMD='security find-generic-password -a "$USER" -s truecoach -w'
```

`VMCP_TRUECOACH_PASSWORD` works too, but it puts the password in plaintext in your
environment. With neither set the tool returns `NOT_CONFIGURED` and makes no network
call; it never prompts.

The access token is cached in memory for its lifetime and on disk at
`~/.voltras/truecoach-token.json`, mode 0600. Raw responses are cached under
`~/.voltras/truecoach-cache/` with a 6-hour TTL — pass `refresh: true` to bypass it. Both
paths are gitignored and neither the token nor the password is ever written to a log line
or an error message.

### What it does

```
your program → "TrueCoach import" block → one week per ISO week → one template per workout
```

Exercise names must match the catalog **exactly** (case- and punctuation-insensitive). A
ranked "close enough" hit is never accepted: a wrong `exerciseId` silently attributes a
lift and its baselines to a movement the coach never prescribed. Unmatched names come back
in `unmapped` with up to three candidates and are skipped — the template still lands — and
you resolve them by re-running with
`mapping: { "<TrueCoach name>": "<catalog exercise id>" }`.

Targets are read from the coach's instruction text by a deliberately narrow parser
(`3 x 8-10 @ 135lb, rest 90s`, `50lbs x AMRAP x 4 sets`, `4 sets of 12`). Anything it
cannot read is left absent, and the **whole instruction is kept verbatim in `notes`**
either way.

Re-importing the same range is idempotent: every row carries a TrueCoach external id
(`tc:workout:<id>`, `tc:item:<id>`) with a unique index behind it, so a second run updates
in place and never duplicates. Use `dryRun: true` to see the mapped tree before writing.

### Terms of service — read this before using it

TrueCoach (an Xplor Technologies brand) **publishes no public developer API**. The
endpoint this uses is undocumented and reverse-engineered. Xplor's terms of use, section
A.4 "Prohibited Activities", say you will not:

> (c) use any robot, spider, crawler, scraper, or other manual or automated means or
> interface to access the Services, retrieve, index, scrape, "data mine" or otherwise
> gather Content or extract other user's information.
>
> (d) use or develop any third-party applications that interact with the Services or other
> users' content or information without our written consent.

Clause (c) is arguably narrowed by "other user's information", which this is not. Clause
(d) has no such qualifier. **The position taken here is a deliberate one**: this is a
client-role read of your OWN data on your OWN account, run by hand, with no write path and
no automation. The coach has not been asked for consent, and TrueCoach has not granted
written consent under clause (d). The account at risk is yours. Do not present this as a
sanctioned integration, and do not point it at anyone else's account.

The write direction is **not** built into this server. Results in TrueCoach are freeform text
and the only working write path anyone has found is browser automation against the DOM. That
path exists as a separate, opt-in tool — see
[TrueCoach write-back (unattended, gated)](#truecoach-write-back-unattended-gated) — and
nothing in the server process ever reaches TrueCoach to write.

Full research, including the alternatives that stay clear of all this:
`sources/notes/2026-09-08-truecoach-integration-research.md`.

---

## Coach results and the outbox

`report.session_results` turns one ended session into the block of text a coach expects to
read back — the same freeform "Result" idiom TrueCoach's own exports use, one string per
exercise:

```
170 lb x 12
170 lb x 10
warm-up: 3 sets
missed: 1 of 3 sets below 8 reps
```

A bilateral effort renders as `L 30 lb x 13` / `R 30 lb x 12`. The `missed:` line appears
only when the session had a plan attached (`plan.complete_workout` /
`plan.attach_to_session`) and a working set fell below its `targetRepsLow`.

A Damper, Band or Isokinetic set has no `weightLbs` to report, so it labels itself by its
own setting instead of showing a missing weight (VMCP-02.74): `damper 6 x 10`, `band x 10`,
`iso x 10`. Band max force is never part of the label — the device does not echo it back in
any settings-update or state-dump frame, so there is nothing observed to report. `describeLoad`
in `src/state/set-capture.ts` is the one place this decision is made; the dashboard's session
summary and set list render the same string.

Which sets count is decided the same way `plan.suggest_progression` decides it: flagged
warm-ups are excluded, then the sets at the top load are kept. A guest lifter's sets
(`session.set_lifter`), mock-adapter sets and zero-rep sets never appear, and an exercise
with no working set is omitted rather than reported empty. The tool reads the store and
makes **no network call** — it never writes to TrueCoach, and nothing in this repo does.

### The outbox

Set `VMCP_TRUECOACH_OUTBOX=on` and every `session.end` also drops the same payload, plus a
`generatedAt` stamp, at:

```
~/.voltras/truecoach-outbox/pending/<sessionId>.json
```

`VMCP_TRUECOACH_OUTBOX_DIR` moves the root; `pending/` is created on demand, mode 0700.
This is a **local file drop, not a pipe**: nothing reads the directory, nothing uploads it,
and nothing schedules anything. It exists so the results of a session survive the
conversation that produced them, ready to paste.

A session with no working sets writes nothing (logged at `debug`), and a write failure is
logged and swallowed — the file is a by-product of `session.end`, never a precondition for
it.

---

## TrueCoach write-back (unattended, gated)

`tools/truecoach-submit/` consumes the outbox and posts one session's results into that day's
TrueCoach workout with a local Playwright browser. It is a standalone package: not part of
the server bundle, not installed by the root `npm ci`, not run by CI. Full documentation is
`tools/truecoach-submit/README.md`. Read both gates first.

**GATE 1.** Xplor ToS A.4(d) forbids third-party apps interacting with the service without
written consent; this job is the human's accepted risk on their own client account, and the
coach should be told before the first real submit.

**GATE 2.** Any DOM selector change fails closed: if one expected element is missing, nothing
is filled and nothing is submitted; there are no partial posts.

### The terms of service

TrueCoach's terms are Xplor's. Section A.4 "Prohibited Activities" says you will not:

> (c) use any robot, spider, crawler, scraper, or other manual or automated means or
> interface to access the Services, retrieve, index, scrape, "data mine" or otherwise
> gather Content or extract other user's information.
>
> (d) use or develop any third-party applications that interact with the Services or other
> users' content or information without our written consent.

This is unambiguous and it covers both directions. Clause (c) is arguably narrowed by "other
user's information" on the extraction clause, but clause (d) has no such qualifier and
prohibits developing any interacting third-party application without written consent. Any
automated route — undocumented API, scraper, or browser automation — is against these terms,
and the account at risk is the coach's business account as much as the athlete's.

The practical read: the terms make an automated integration a policy risk, not a technical
one. Asking the coach to ask TrueCoach for written consent, or simply keeping a human
clicking the submit button, are the two ways to stay on the right side of it.

**Tell the coach before the first real submit.** They carry account risk they did not choose.

### First run

```
cd tools/truecoach-submit && npm ci && npx playwright install chromium   # ~140 MB, once
truecoach-submit login                       # headed; you sign in and pass MFA yourself
truecoach-submit                             # dry run over everything pending
open ~/.voltras/truecoach-outbox/screens/…   # read the screenshot
truecoach-submit --submit --session <id>     # one session, for real
```

The tool never types a password. The dry run is also the verification step for the submit
selector, which ships marked UNVERIFIED — nobody has clicked it, so confirm it against the
screenshot before the first `--submit`.

### The ledger, and resetting one session

Every posted exercise is appended to `~/.voltras/truecoach-outbox/ledger.json`. A rerun of a
fully-recorded session is a no-op; a half-recorded one is refused rather than reconciled. To
re-post a session, remove its records from the ledger and move its JSON from `sent/` back to
`pending/` — the procedure is in the tool's README. Do that only after confirming the results
are not already in TrueCoach.

### Scheduling

`tools/truecoach-submit/launchd/` holds a documented plist (not installed by the package)
running `--submit --all` once a day after training hours. Alternatively
`VMCP_TRUECOACH_SUBMIT_ON_END='on'` makes this server spawn the submitter once per written
entry, detached. Use one trigger at a time.

---

## Troubleshooting

**`device.scan` finds nothing.** Wake the device screen. Then check macOS Bluetooth
permission for the app that launched the server (terminal or Claude Code), under System
Settings → Privacy & Security → Bluetooth. Then confirm the native BLE module actually
built — it's an optional dependency, so a failed build is silent at install time.

**Tool calls return `STARTING`.** Bootstrap hasn't finished. Retry after a second.

**`/app` shows "SPA not built".** Run `npm run build:dashboard`.

**The dashboard is unreachable.** You are probably on the wrong port: another instance
holds 7723, so this session fell back to an OS-assigned one. Call `server.health` and read
`dashboardUrl` (or check stderr — the sidecar logs the URL it bound to). A null
`dashboardUrl` means `VMCP_DASHBOARD_PORT` is `off` or the bind failed outright.

**Nothing works and the error mentions `node:sqlite`.** Your Node is older than 22.5.0.

**Voice input hears nothing.** Call `server.health` and read `voiceReady`. A false
`whisperCli` means `npm ci` wiped the compiled binary (VW-155) — run
`node scripts/ensure-whisper.mjs`, which needs cmake.

**No spoken cues.** Call `server.health` and read `cues` / `cuesMidSet` — both default to
`off`, and cues are macOS-only regardless. `system.set_cues` turns either on without a
restart; the mid-set categories (`target_hit`, `slowdown`) need BOTH on.

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
and the tests related to staged files. A pre-push hook runs `prettier --check` on files
changed vs `origin/main`; bypass with `git push --no-verify`.

Repo-specific conventions live in `CLAUDE.md`; the dashboard's architecture is documented
in `src/dashboard/README.md`.

---

## Confidentiality

No protocol bytes, raw frame payloads, or proprietary command codes belong in tool I/O,
schemas, log lines, documentation, or commits. Only typed values from the SDK's public
surface cross the MCP boundary. ESLint enforces part of this by flagging `Buffer` access
inside handler functions.
