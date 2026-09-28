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
  - plugins/voltras-channel/bin/voltras-mcp-launch.sh
  - scripts/voltra-pt
  - site/reference/environment-variables.md
lastVerified: 2026-09-28
---

# Set up and open the dashboard

This page gets the wall dashboard onto a screen: build it, launch the server so the dashboard
is on, find its address, and open it before your first set. It assumes you have
[installed](/start/install) the server. For what the dashboard shows, read the
[dashboard overview](/guides/dashboard).

## 1. Build the dashboard

The server and the dashboard are two build steps. Run both from the repository root:

```sh
npm run build && npm run build:dashboard
```

`npm run build` alone gives you a working server whose `/app` page shows only a "SPA not
built" placeholder (`README.md:69-73`, `src/dashboard/server.ts:1948-1953`). The plugin
launcher runs `npm run build:dashboard` for you when the built dashboard is missing or older
than its source (`plugins/voltras-channel/bin/voltras-mcp-launch.sh:80-85`).

## 2. Launch so the dashboard is on

Whether the dashboard starts depends on how you launch the server:

- **Registered with `claude mcp add`.** The dashboard is on. The server starts it unless
  `VMCP_DASHBOARD_PORT` is `off` or `0` (`src/server.ts:56-62`).
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
- `dashboardDisabledReason` is `"disabled"` when `VMCP_DASHBOARD_PORT=off` turned the
  dashboard off, and `null` otherwise (`src/tools/server-tools.ts:255`).

The default port is `7723` (`src/dashboard/server.ts:240`). When another process already
holds it, for example a second Claude Code session, the dashboard binds a port the operating
system picks instead of failing (`src/server.ts:145-157`). So read `dashboardUrl` rather than
typing `7723`. The server also writes the address it bound to stderr
(`src/server.ts:157`).

## 4. Open it before the first set

Open `dashboardUrl` in a browser on the same machine. The dashboard binds `127.0.0.1` only,
so another computer or a phone on your network cannot reach it
(`src/dashboard/server.ts:242`).

Open it before you start the first set. The live page builds its set log in the browser as
each set closes, so a page opened after the last set has nothing to show (`README.md:262`).

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
dashboard failed to start even on a port the operating system picked. The server logs the
reason to stderr and keeps running without a dashboard (`src/server.ts:158-170`).

### The page says "SPA not built"

The server is built but the dashboard is not. Run `npm run build:dashboard` and reload the
page (`src/dashboard/server.ts:1948-1953`).

### The page shows a different session

Another session's server holds `7723`, and you opened that one. This session's dashboard is
on another port: open the `dashboardUrl` that this session's `server.health` returns.
[Troubleshooting](/guides/troubleshooting#the-dashboard-is-unreachable) covers the same case.
