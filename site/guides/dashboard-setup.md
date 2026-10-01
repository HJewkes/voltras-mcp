---
diataxis: how-to
audience: [lifter, coach, developer]
status: available
sources:
  - README.md
  - src/server.ts
  - src/dashboard/server.ts
  - src/tools/server-tools.ts
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/spa/adapter.ts
  - src/state/live-state.ts
  - plugins/voltras-channel/bin/voltras-mcp-launch.sh
  - scripts/voltra-pt
  - site/reference/environment-variables.md
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Set up and open the dashboard

This page gets the wall dashboard onto a screen: build it, launch the server so the dashboard
is on, find its address, and open it. It assumes you have
[installed](/start/install) the server. For what the dashboard shows, read the
[dashboard overview](/guides/dashboard).

## 1. Build the dashboard

The server and the dashboard are two build steps. Run both from the repository root:

```sh
npm run build && npm run build:dashboard
```

`npm run build` alone gives you a working server whose `/app` page shows only a "SPA not
built" placeholder (`README.md:69-73`, `src/dashboard/server.ts:2022-2025`). The plugin
launcher runs `npm run build:dashboard` for you when the built dashboard is missing or older
than its source (`plugins/voltras-channel/bin/voltras-mcp-launch.sh:80-87`).

## 2. Launch so the dashboard is on

Whether the dashboard starts depends on how you launch the server:

- **Registered with `claude mcp add`.** The dashboard is on. The server starts it unless
  `VMCP_DASHBOARD_PORT` is `off` or `0` (`src/server.ts:56-59`).
- **`scripts/voltra-pt`.** The dashboard is on. In its default plugin mode the script sets `VOLTRA_PT=1`, which tells
  the plugin launcher to leave the dashboard at its default port (`scripts/voltra-pt:95-97`).
- **Any other plugin launch.** The dashboard is off. The plugin launcher sets
  `VMCP_DASHBOARD_PORT=off` when that variable is unset and `VOLTRA_PT` is not `1`, so a
  session that is not a workout does not hold a port
  (`plugins/voltras-channel/bin/voltras-mcp-launch.sh:45-46`). To turn it on, set
  `VMCP_DASHBOARD_PORT=7723` in your environment or in `.launch.env` at the repository root,
  which the launcher reads after that default (`plugins/voltras-channel/bin/voltras-mcp-launch.sh:71-74`).

[Launch options](/start/launch-options) compares the launch routes, and the
[environment variables](/reference/environment-variables) reference lists
`VMCP_DASHBOARD_PORT`.

## 3. Find its address

Ask Claude to call [`server.health`](/reference/server), or call it yourself. Three fields
answer the question:

- `dashboardAvailable` is `true` when the dashboard is running.
- `dashboardUrl` is the full address to open. It ends in `/app` and names the port this
  session actually bound (`src/tools/server-tools.ts:252`).
- `dashboardDisabledReason` is `"disabled"` when `VMCP_DASHBOARD_PORT` set to `off` or `0`
  turned the dashboard off, and `null` otherwise (`src/server.ts:59`, `src/server.ts:180`).

The default port is `7723` (`src/dashboard/server.ts:243`). When another process already
holds it, for example a second Claude Code session, the dashboard binds a port the operating
system picks instead of failing (`src/server.ts:148-157`, `src/dashboard/server.ts:413`). So read `dashboardUrl` rather than
typing `7723`. The server also writes the address it bound to stderr, as an `info` log
line (`src/server.ts:157`).

## 4. Open it

Open `dashboardUrl` in a browser on the same machine. The dashboard binds `127.0.0.1` only,
so another computer or a phone on your network cannot reach it
(`src/dashboard/server.ts:245`).

You can open it at any point in a session. While a session is open, the server sends that
session's finished sets with every update, so a page opened or reloaded mid-session shows
the sets already done (`src/state/live-state.ts:1340-1351`,
`src/dashboard/spa/adapter.ts:755-766`). When the session ends, the live page clears its set
log; the **review** screen shows the finished session.

Before a Voltra connects, the live page says so instead of showing empty panels:

![The wall dashboard before a Voltra is connected.](/captures/dashboard-cold.png)

The nav rail on the left moves between the screens: **live**, **program** (the plan builder),
**review** (the latest session summary) and **body**
(`src/dashboard/spa/panels/DashboardChrome.tsx:34-39`). The
[overview](/guides/dashboard#the-five-screens) says which screens are available.

## When it does not open

### `dashboardUrl` is null

Read `dashboardDisabledReason`. If it is `"disabled"`, `VMCP_DASHBOARD_PORT` is `off` or
`0`; step 2 says where that comes from and how to turn the dashboard on. If it is `null`, the
dashboard failed to start. Either the port was held and the fallback port the operating
system picked failed too, or the bind failed for another reason, which gets no fallback. The
server logs the reason to stderr and keeps running without a dashboard
(`src/server.ts:158-170`, `src/dashboard/server.ts:413`).

### The page says "SPA not built"

The server is built but the dashboard is not. Run `npm run build:dashboard` and reload the
page (`src/dashboard/server.ts:2022-2025`).

### The page shows a different session

Another session's server holds `7723`, and you opened that one. This session's dashboard is
on another port: open the `dashboardUrl` that this session's `server.health` returns.
[Troubleshooting](/guides/troubleshooting#the-dashboard-is-unreachable) covers the same case.
