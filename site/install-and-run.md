# Install and run

## Install

### Requirements

- **Node >= 22.5.0.** The store is built on `node:sqlite`, which does not exist in older
  releases. An older Node fails at startup with a module-resolution error for `node:sqlite`.
  ([README.md § Requirements](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#requirements))
- **Real hardware, macOS:** Bluetooth permission for whichever app launches the server
  (terminal or Claude Code — macOS grants access per-app), and Xcode Command Line Tools
  (`xcode-select --install`), because the native BLE module is an optional dependency of
  `@voltras/node-sdk` and a failed build fails silently at install time.
  ([README.md § Requirements](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#requirements))
- **No hardware?** Skip both of the above — see [without a device](#without-a-device) below.
- **Claude Code v2.1.80 or later** for the optional push-event stream.
  ([README.md § Requirements](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#requirements))

### Clone and build

The package is **not published to npm** — `npx voltras-mcp` does not work.

```bash
git clone <this-repo> voltras-mcp
cd voltras-mcp

npm install              # ~1000 packages
npm run build            # tsc → dist/ (the server binary)
npm run build:dashboard  # vite → dist/spa (the web dashboard)
```

Both build steps matter: `npm run build` alone leaves the dashboard's `/app` route serving
a "SPA not built" placeholder.
([README.md § Quickstart](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#quickstart))

Register it with Claude Code, pointing at the built entry point, then restart Claude Code:

```bash
claude mcp add voltras -- node "$PWD/dist/bin.js"
```

Ask Claude to call `server.health` to confirm the connection end to end. For every tool the
server exposes, see the [capability reference](/reference/).
([README.md § Quickstart](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#quickstart))

### Without a device

Set `VOLTRA_ADAPTER=mock` to replace BLE with an in-process device that streams synthetic
telemetry through the same pipeline a real unit uses. The tool surface is identical, plus
two extra tools (`mock.configure`, `mock.inject_error`).
([README.md § Your first workout, Option B](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#option-b-without-a-device))

```bash
claude mcp add voltras -e VOLTRA_ADAPTER=mock -- node "$PWD/dist/bin.js"
```

Two scripted drivers boot a dashboard and animate a workout into it without any MCP client
at all — useful for seeing the UI before you own a device:

```bash
npm run dashboard:sim                   # port 7799 — scripted state, no MCP server, no SDK
node scripts/dashboard-mock-drive.mjs   # port 7724 — boots the real MCP server in mock
                                         # mode and drives it through real tool calls
```

([README.md § Your first workout, Option B](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#option-b-without-a-device))

---

## Running

There are two ways to launch the server, both going through the same launcher script:
`plugins/voltras-channel/bin/voltras-mcp-launch.sh`. It builds the dashboard SPA when
stale, sources `.launch.env` from the repo root when present, then execs the built server.
([README.md § Launching](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#launching))

::: warning Not independently verified
The plugin install steps below (marketplace add, plugin install, the managed-settings
file) were not run from this worktree — worktree isolation for this page's changes
excludes installing plugins or editing machine-wide settings. Treat them as documented,
not re-confirmed here; they're verified in
[docs/channel-plugin-packaging.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/channel-plugin-packaging.md#verification-status).
:::

### Route 1: the `voltra-pt` plugin launcher — pick this if you want push events

`scripts/voltra-pt` starts Claude Code with the channel capability enabled, so the server
can push rep- and set-level events into the conversation instead of the model polling for
them, and prefills a personal-trainer prompt.

```bash
lift                                    # default PT prompt
lift "let's do a back day"              # custom starting prompt
```

One-time setup: add the marketplace, install the plugin, and point it at this checkout —

```bash
claude plugin marketplace add "$PWD"     # an absolute path; "." is rejected
claude plugin install voltras-channel@voltras-local
echo "$PWD" > ~/.voltras/mcp-home
```

— plus a machine-wide managed-settings file that allowlists the plugin. See
[docs/channel-plugin-packaging.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/channel-plugin-packaging.md#the-managed-settings-file)
for that file and the reasoning behind the packaging.
([README.md § Quickstart, Optional: the voltra-pt launcher](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#optional-the-voltra-pt-launcher))

The plugin ships the MCP server itself, so don't also register `voltras` via `claude mcp
add` — two processes would collide on the database and the dashboard port. The launch
script checks for this and refuses to launch.
([README.md § Quickstart](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#optional-the-voltra-pt-launcher))

Set `VOLTRA_PT_DEV=1` to fall back to
`--dangerously-load-development-channels` instead of the plugin, for when the
managed-settings file isn't installed.
([README.md § Quickstart](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#optional-the-voltra-pt-launcher))

### Route 2: `just` recipes / plain commands — pick this if you don't need push events

`just` is optional; every recipe is a one-line wrapper you can run directly instead:

| Recipe           | Plain command                                                |
| ---------------- | ------------------------------------------------------------ |
| `just build`     | `npm run build`                                              |
| `just dashboard` | `npm run build:dashboard`                                    |
| `just test`      | `npm test`                                                   |
| `just typecheck` | `npm run typecheck`                                          |
| `just lint`      | `npm run lint`                                               |
| `just sim`       | mock adapter + dashboard on an OS-assigned port, isolated DB |
| `just bench`     | `node scripts/preflight.mjs`, then the plugin launcher       |

([README.md § Launching, just recipes](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#just-recipes))

### Registering directly via `~/.claude.json`

You can point Claude Code at the launcher script without installing it as a plugin, by
adding an entry to the `mcpServers` map in `~/.claude.json`:

```json
"voltras": {
  "command": "/absolute/path/to/voltras-mcp/plugins/voltras-channel/bin/voltras-mcp-launch.sh",
  "env": { "VOLTRAS_MCP_HOME": "/absolute/path/to/voltras-mcp" }
}
```

**Caveat:** a `server:<name>` entry registered this way can never be allowlisted for the
push channel, so events fall back to polling. For push events, install it as the
`voltras-channel` plugin instead (Route 1).
([README.md § Launching, Registering directly via ~/.claude.json](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#registering-directly-via-claudejson))

### Running more than one instance

Stdio is a single-client transport — every Claude Code session spawns its own
`voltras-mcp` process. Two instances with default settings collide on **port 7723** and on
the **SQLite file** at `~/.voltras/vmcp.sqlite`. The store's write-lock probe on open only
rejects a newcomer if the incumbent happens to hold a write lock at that instant — it's a
best-effort check, not a guarantee. Give each parallel session a distinct `VMCP_DB_PATH`
**and** `VMCP_DASHBOARD_PORT`:

```bash
claude mcp add voltras-b \
  -e VMCP_DB_PATH=/Users/you/.voltras/vmcp-b.sqlite \
  -e VMCP_DASHBOARD_PORT=7724 \
  -- node "$PWD/dist/bin.js"
```

([README.md § Running more than one instance](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#running-more-than-one-instance))

Startup itself is connect-first — the transport is live immediately, and tool calls return
a structured `STARTING` error during bootstrap rather than blocking. Expect sub-second
readiness in mock mode and roughly one to two seconds in node mode while BLE comes up.
([README.md § Startup latency](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#startup-latency))

---

## Environment variables

Everything is optional; the defaults are a working configuration. Full descriptions are in
[README.md § Environment variables](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#environment-variables) —
this table adds three diagnostic variables that are read in code but not in that table.

| Var                                                | Default                           | Notes                                                                                                                                                                                        |
| -------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOLTRA_ADAPTER`                                   | `node`                            | `node` \| `mock`. BLE adapter.                                                                                                                                                               |
| `VMCP_DB_PATH`                                     | `~/.voltras/vmcp.sqlite`          | SQLite store path.                                                                                                                                                                           |
| `VMCP_DASHBOARD_PORT`                              | `7723`                            | Dashboard sidecar port; `off`/`0` disables it.                                                                                                                                               |
| `VMCP_LOG_LEVEL`                                   | `info`                            | `debug` \| `info` \| `warn` \| `error`.                                                                                                                                                      |
| `VMCP_CUES`                                        | `off`                             | Spoken coaching cues. macOS only.                                                                                                                                                            |
| `VMCP_CUES_MIDSET`                                 | `off`                             | Whether mid-set cue categories may speak.                                                                                                                                                    |
| `VMCP_REST_TIMER`                                  | `off`                             | Auto-arm the rest-status push cycle on set close.                                                                                                                                            |
| `VMCP_AUTO_ARM`                                    | `on`                              | Open a set on the server's own initiative when reps are detected.                                                                                                                            |
| `VMCP_REP_SOURCE`                                  | `analytics`                       | `analytics` \| `firmware`.                                                                                                                                                                   |
| `VMCP_REP_CORRECTIONS`                             | `off`                             | Movement-class-dependent rep-segmentation corrections.                                                                                                                                       |
| `VMCP_SLOT_BINDINGS_PATH`                          | `~/.voltras/slot-bindings.json`   | Device ↔ left/right side bindings.                                                                                                                                                           |
| `VMCP_DEBUG_BUFFER_SIZE`                           | `256`                             | Capacity of the diagnostic ring buffer.                                                                                                                                                      |
| `VMCP_TRUECOACH_USERNAME`                          | _unset_                           | TrueCoach account email.                                                                                                                                                                     |
| `VMCP_TRUECOACH_PASSWORD`                          | _unset_                           | TrueCoach password, plaintext. Prefer `_PASSWORD_CMD`.                                                                                                                                       |
| `VMCP_TRUECOACH_PASSWORD_CMD`                      | _unset_                           | Command whose stdout is the password.                                                                                                                                                        |
| `VMCP_TRUECOACH_CLIENT_ID`                         | token response `user_id`          | Override for the TrueCoach client id.                                                                                                                                                        |
| `VMCP_TRUECOACH_TOKEN_PATH`                        | `~/.voltras/truecoach-token.json` | Cached access token, mode 0600.                                                                                                                                                              |
| `VMCP_TRUECOACH_CACHE_DIR`                         | `~/.voltras/truecoach-cache`      | Raw response cache, 6-hour TTL.                                                                                                                                                              |
| `VMCP_TRUECOACH_OUTBOX`                            | `off`                             | Write session results to a local outbox file on `session.end`.                                                                                                                               |
| `VMCP_TRUECOACH_OUTBOX_DIR`                        | `~/.voltras/truecoach-outbox`     | Outbox root.                                                                                                                                                                                 |
| `VMCP_TRUECOACH_SUBMIT_ON_END`                     | `off`                             | Spawn the (separate, opt-in) TrueCoach submitter after an outbox write.                                                                                                                      |
| `VMCP_RECORD_SESSION` _(diagnostic, undocumented)_ | _unset_                           | Appends every inbound raw BLE frame to a capture file when set. ([`src/state/session-recorder.ts:127`](https://github.com/HJewkes/voltras-mcp/blob/main/src/state/session-recorder.ts#L127)) |
| `VMCP_CAPTURE_DIR` _(diagnostic, undocumented)_    | `~/.voltras/captures`             | Overrides where `VMCP_RECORD_SESSION` writes captures. ([`src/state/session-recorder.ts:130`](https://github.com/HJewkes/voltras-mcp/blob/main/src/state/session-recorder.ts#L130))          |
| `VOLTRAS_VAD_MODEL` _(diagnostic, undocumented)_   | built-in model                    | Overrides the Silero VAD model path used by the local voice listener. ([`src/voice/vad.ts:100`](https://github.com/HJewkes/voltras-mcp/blob/main/src/voice/vad.ts#L100))                     |

`VOLTRA_ADAPTER`, `VMCP_REP_SOURCE`, `VMCP_REST_TIMER`, `VMCP_REP_CORRECTIONS`,
`VMCP_AUTO_ARM`, `VMCP_TRUECOACH_OUTBOX`, `VMCP_TRUECOACH_SUBMIT_ON_END`, and `VMCP_CUES`
throw synchronously at startup on an unrecognized value.
([README.md § Environment variables](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#environment-variables))
