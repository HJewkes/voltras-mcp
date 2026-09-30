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
  - src/config.ts
  - src/docs/environment-variables.ts
lastVerified: 2026-09-30
sourced: 2026-09-30
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
  & Security, Bluetooth. Without it, expect `device.scan` to find no devices, with no error
  that names the permission. ([README.md § Requirements](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#requirements))
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

npm install
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
[launch options](/start/launch-options). Do not use both. That starts two server processes on
the same database, and the store does not stop the second one reliably
([README.md § Running more than one instance](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#running-more-than-one-instance)).

For every tool the server exposes, see the [capability reference](/reference/).

## Environment variables

Everything is optional; the defaults are a working configuration. The
[environment variable reference](/reference/environment-variables) lists every variable the
server reads, with its default, what it accepts, and what an invalid value does. That page is
generated from `src/docs/environment-variables.ts`, and a docs test checks it against the
code. Most variables are read once at startup. An unrecognized value for an on/off switch,
`VOLTRA_ADAPTER`, `VMCP_REP_SOURCE` or `VMCP_MOUNT_RATING_LBS` stops the server before it
starts (`src/config.ts`).
