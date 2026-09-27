---
diataxis: how-to
audience: [lifter, developer]
status: available
sources:
  - README.md
  - src/tool-registry.ts
  - docs/dashboard-drivers.md
  - scripts/dashboard-sim.mjs
  - scripts/dashboard-mock-drive.mjs
  - scripts/dashboard-plan-drive.mjs
  - scripts/dashboard-preview.mjs
  - src/docs/preview-seeds.ts
  - justfile
  - src/dashboard/spa/panels/DashboardChrome.tsx
lastVerified: 2026-09-27
---

# Try it without a device

You can run the whole tool surface and see the wall dashboard without a Voltra. This page
covers three ways to do that: the mock adapter, the scripted dashboard drivers, and
`npm run dashboard:preview`. Every command here needs the two build steps from
[Install](/start/install) first.

## The mock adapter

Set `VOLTRA_ADAPTER=mock` to replace Bluetooth with an in-process device. The mock device
streams synthetic telemetry through the same pipeline a real unit uses.
([README.md § Option B](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#option-b-without-a-device))

```bash
claude mcp add voltras -e VOLTRA_ADAPTER=mock -- node "$PWD/dist/bin.js"
```

The tool surface is the same as on real hardware, plus two mock-only tools,
[`mock.configure`](/reference/mock) and [`mock.inject_error`](/reference/mock)
(`MOCK_TOOL_NAMES` in `src/tool-registry.ts`). With the mock adapter registered, you can
follow [your first session](/start/first-session) from start to finish.

`just sim` is a one-line alternative. It starts the launcher with the mock adapter, a
throwaway database under `/tmp`, and the dashboard on an OS-assigned port (`justfile`).

## Watch a workout on the dashboard

The drivers below start a dashboard and play a workout into it with no MCP client. They
differ in how much of the real pipeline they use.
([docs/dashboard-drivers.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/dashboard-drivers.md))

| Command                                 | Default port | What it runs                                                                        |
| --------------------------------------- | ------------ | ----------------------------------------------------------------------------------- |
| `npm run dashboard:sim`                 | 7799         | A scripted fake state. No MCP server and no SDK. It cannot show a plan.             |
| `node scripts/dashboard-mock-drive.mjs` | 7724         | The real MCP server in mock mode, driven through real tool calls. No plan attached. |
| `node scripts/dashboard-plan-drive.mjs` | 7726         | The same real pipeline, plus a real plan attached to the session.                   |

The ports come from each script (`scripts/dashboard-sim.mjs`,
`scripts/dashboard-mock-drive.mjs`, `scripts/dashboard-plan-drive.mjs`). The two
real-pipeline drivers each default to their own database in the system temp directory, so
they do not touch `~/.voltras/vmcp.sqlite`.

Open `http://127.0.0.1:<port>/app` before or during the run. The set log builds up in the
browser from live transitions, so a page opened after the last set has nothing to show.
([README.md § Option B](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#option-b-without-a-device))

Useful options, from each script's header comment:

- `dashboard:sim` takes `PORT=`, `LOOP=1` to repeat the workout, `DUAL=1` for two devices,
  and `TRANSITIONS=1` to bind and drop a second device mid-set.
- `dashboard-mock-drive.mjs` takes `VMCP_DASHBOARD_PORT=`, `--dual` for two devices, and
  `HOLD=0` to exit when the workout ends.
- `dashboard-plan-drive.mjs` takes `--pinned-reps=N` to run every set at exactly N reps.

[First session, Option B](/start/first-session#option-b-without-a-device) shows the output
of a `dashboard-mock-drive.mjs` run.

## Browse the other wall pages

The drivers above fill the live page. The other wall pages read the stored history, so a
driver that streams into a fresh store leaves them nearly empty.
([docs/dashboard-drivers.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/dashboard-drivers.md#the-ladder-is-about-the-live-page-dashboardpreview-is-about-the-others-vw-416))

`npm run dashboard:preview` seeds a scratch store, starts a mock-adapter server over it on a
free port, prints the URL, and holds the server open until Ctrl-C
(`scripts/dashboard-preview.mjs`):

```bash
npm run dashboard:preview -- body                   # #/body
npm run dashboard:preview -- plan                   # #/plan
npm run dashboard:preview -- goals                  # #/goals
npm run dashboard:preview -- goals --state behind   # …with a chosen goal state
```

A `body` run on 2026-09-27 printed this (trimmed: five lines are cut, the seed line and
two Node `ExperimentalWarning` warnings, each followed by its `--trace-warnings` hint line):

```
> voltras-mcp@0.5.0 dashboard:preview
> node scripts/dashboard-preview.mjs body

[INFO] dashboard sidecar listening at http://127.0.0.1:56977/app
[INFO] voltras-mcp ready
[preview] body: dashboard on :56977

  A training week's volume per muscle, what is due next, and recent PRs.
  http://127.0.0.1:56977/app#/body

[preview] holding the server open — Ctrl-C to stop and remove the scratch store.
```

The port changes on every run, so copy the URL the command prints. Ctrl-C removes the
scratch store. The command never opens `~/.voltras/vmcp.sqlite` (`scripts/dashboard-preview.mjs`).
If `dist/` or `dist/spa/` is missing, the command stops and names the build step to run.

`body` and `plan` reuse the scenarios that produce this site's screenshots, so the page you
browse matches the published images. `goals` has a seed of its own
(`src/docs/preview-seeds.ts`). The goals page has no entry in the dashboard's navigation
rail yet, so you reach it by URL only (`src/dashboard/spa/panels/DashboardChrome.tsx`).

`--state` applies to `goals` only. It takes one of `calibrating`, `recalibration_offered`,
`recalibration_declined`, `on_track`, `fast_climb`, `behind`, `stalled`, `ahead`,
`hit_exact` or `beyond_goal`, and defaults to `on_track` (`src/docs/preview-seeds.ts`,
`scripts/dashboard-preview.mjs`). The command prints the status the page actually reached.

::: warning The printed status can differ from --state
A `goals --state behind` run on 2026-09-27 printed this (trimmed to the two status lines):

```
[preview] seeded --state behind: 15 sets across 5 session(s), top 100 lb, baseline CALIBRATED, whole body: bodyweight, sessions_28d
[preview] goal read model: status on_track
```

Read the `goal read model: status` line before you rely on the page showing a given state.
:::
