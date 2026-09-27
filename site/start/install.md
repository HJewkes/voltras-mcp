---
diataxis: how-to
audience: [lifter, developer]
status: available
sources:
  - README.md
  - package.json
  - src/store/sqlite-store.ts
  - src/dashboard/server.ts
  - docs/bench-preflight.md
  - docs/push-events.md
  - src/state/session-recorder.ts
  - src/voice/vad.ts
lastVerified: 2026-09-27
---

# Install

This page takes you from a fresh machine to a `voltras` server that Claude Code can call.
When it is done, run [your first session](/start/first-session). To launch the server some
other way, see [launch options](/start/launch-options).

## Requirements

- **Node 22.5.0 or later.** The store uses the built-in `node:sqlite` module
  (`src/store/sqlite-store.ts`), and `package.json` declares `"node": ">=22.5.0"` under
  `engines`. On an older Node the server fails at startup with a module-resolution error for
  `node:sqlite`, which does not name a version. Run `node --version` before you start.
  ([README.md § Requirements](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#requirements))
- **Claude Code**, the MCP client. The optional push-event stream needs v2.1.80 or later
  ([docs/push-events.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/push-events.md)).
- **For a real Voltra on macOS, Bluetooth permission** for the app that launches the server,
  normally your terminal app or the Claude Code desktop app. macOS grants Bluetooth access
  per app. If you dismissed the first prompt, grant it again under System Settings, Privacy
  & Security, Bluetooth. Without it, `device.scan` returns no devices and gives no other
  clue. ([README.md § Requirements](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#requirements))
- **For a real Voltra, the Xcode Command Line Tools** (`xcode-select --install`). The BLE
  module `@stoprocent/noble` is an optional dependency of `@voltras/node-sdk` and may compile
  from source on a recent Node. Because the dependency is optional, a failed compile does not
  fail `npm install`. You find out later, when a connect does not work.
  ([README.md § Requirements](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#requirements))
- **No Voltra?** Skip the two hardware items. [Try it without a device](/start/try-without-a-device)
  covers the mock adapter.

## Clone and build

The package is not published to npm, so `npx voltras-mcp` does not work. Clone the
repository and build it. ([README.md § Quickstart](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#quickstart))

```bash
git clone <this-repo> voltras-mcp
cd voltras-mcp

npm install              # ~1000 packages
npm run build            # tsc → dist/ (this produces the server binary)
npm run build:dashboard  # vite → dist/spa (this produces the web dashboard)
```

Run both build steps. `npm run build` compiles the server into `dist/`, and
`npm run build:dashboard` builds the web dashboard into `dist/spa` (`package.json`). If
`dist/spa` is missing, the dashboard's `/app` route serves a "SPA not built" placeholder
page instead (`src/dashboard/server.ts`).

## Register with Claude Code

Point Claude Code at the built entry point:

```bash
claude mcp add voltras -- node "$PWD/dist/bin.js"
```

Restart Claude Code. The `voltras` tools and resources then appear. Ask Claude to call
[`server.health`](/reference/server) to confirm the connection end to end.
([README.md § Quickstart](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#quickstart))

To pass configuration, add `-e` flags. This example uses the mock adapter and turns spoken
cues on:

```bash
claude mcp add voltras -e VOLTRA_ADAPTER=mock -e VMCP_CUES=on -- node "$PWD/dist/bin.js"
```

As an alternative, `npm link` exposes the `voltras-mcp` bin globally, and
`claude mcp add voltras -- voltras-mcp` registers that. The README prefers the absolute path,
because a later global install can clear the link. ([README.md § Quickstart](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#quickstart))

This is plain registration: tools work, but the server cannot push events into the
conversation. For push events, use the `voltra-pt` launcher on
[launch options](/start/launch-options). Do not use both, because two server processes
collide on the database and the dashboard port.

For every tool the server exposes, see the [capability reference](/reference/).

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
| `VMCP_REP_UNRACK_DROP`                             | `off`                             | Drop the un-rack artifact rep at set close. Changes the persisted rep count; dark pending movement-class validation.                                                                         |
| `VMCP_REP_ECC_TRUNCATE`                            | `on`                              | Truncate the final rep's parked idle tail off its eccentric at set close.                                                                                                                    |
| `VMCP_REP_CORRECTIONS`                             | _unset_                           | Legacy coarse switch over both of the above; either one's own variable overrides it.                                                                                                         |
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
`VMCP_REP_UNRACK_DROP`, `VMCP_REP_ECC_TRUNCATE`,
`VMCP_AUTO_ARM`, `VMCP_TRUECOACH_OUTBOX`, `VMCP_TRUECOACH_SUBMIT_ON_END`, and `VMCP_CUES`
throw synchronously at startup on an unrecognized value.
([README.md § Environment variables](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#environment-variables))
