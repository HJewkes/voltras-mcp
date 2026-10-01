---
diataxis: explanation
audience: [lifter, coach, developer]
status: available
sources:
  - README.md
  - src/dashboard/server.ts
  - src/dashboard/write-guard.ts
  - src/dashboard/spa/routing.ts
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/spa/main.tsx
  - src/dashboard/spa/live-stream.ts
  - src/dashboard/spa/planner/planner-client.ts
  - src/docs/capture-shots.ts
  - src/dashboard/spa/adapter.ts
  - src/dashboard/spa/live-page/model.ts
  - src/server.ts
  - docs/dashboard-drivers.md
  - site/public/captures/manifest.json
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# The wall dashboard

The wall dashboard is a local web page that voltras-mcp starts beside the MCP server. Put it
on a screen you can see from the machine: it shows the set you are doing as you do it, the
session when you finish, and the plan behind it. Claude still runs the workout; the dashboard
shows what the server records.

![The live page mid-set, with the prescribed sets, reps, load and tempo attached.](/captures/live-mid-set.png)

## What it is

- **Local.** The dashboard binds `127.0.0.1` only, so you open it on the machine that runs the
  server and no other machine can reach it (`src/dashboard/server.ts:245`).
- **One per session.** Each Claude Code session runs its own server, and each server starts
  its own dashboard on its own port (`src/server.ts:148-157`).
- **Mostly read-only.** The live page and the session summary only read. The plan builder is
  the one page that writes, and each of its edits needs a same-origin request that carries a
  per-boot write token (`src/dashboard/server.ts:96-99`, `src/dashboard/write-guard.ts:85-95`).
- **No effort reading yet.** The live page and the session summary show velocity loss and a
  fatigue verdict, but no measured RPE or reps in reserve. The live page does show an effort
  target under the prescription: the plan's RPE, or your tier's default target
  (`src/dashboard/spa/live-page/model.ts:472-488`). The
  [effort readout](/coming-soon/effort-readout) is coming soon.

No capture on this site comes from a real Voltra. Most captures come from the real MCP
tools running against the mock adapter (`VOLTRA_ADAPTER=mock`). The goals capture also seeds
the store before boot: a prior-week set and, for the whole-body cards, five weeks of weigh-ins
(`scripts/dashboard-mock-drive.mjs:241-296`). The body capture comes entirely from training
rows seeded into the store, because the per-muscle reads leave mock sets out
(`src/docs/capture-shots.ts:165-176`).

## The five screens

The dashboard is one page with five hash routes. The nav rail on the left has four entries:
**live**, **program**, **review** and **body** (`src/dashboard/spa/panels/DashboardChrome.tsx:34-39`).
An unknown route opens the live page (`src/dashboard/spa/routing.ts:48-60`).

| Screen          | Status                                 | Route       | How to open it                                  | What you do there                                                                                   |
| --------------- | -------------------------------------- | ----------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Live            | Available                              | `#/`        | The dashboard URL, or **live** in the rail      | Watch the current set: rep velocity against the loss lines, the fatigue card, and the prescription. |
| Plan builder    | Available                              | `#/plan`    | **program** in the rail                         | Browse the exercise catalog, then build, change or reorder a workout.                               |
| Session summary | Available                              | `#/summary` | **review** in the rail; `#/summary/<sessionId>` | Read one session back: totals, the fatigue verdict, each set, and a load recommendation.            |
| Goals           | [Coming soon](/coming-soon/goals-page) | `#/goals`   | By URL only: the rail has no entry for it       | Built but not usable yet. Its page says what is missing.                                            |
| Body            | [Coming soon](/coming-soon/body-map)   | `#/body`    | **body** in the rail                            | Built but not usable yet. Its page says what is missing.                                            |

The [dashboard pages](/reference/dashboard-pages) reference lists the data each screen reads.

### Live, between sets

When a set closes, the live page switches to its rest stage: the set just finished, its
verdict, and a rest ring.

![The rest stage between two sets of a planned exercise.](/captures/live-rest.png)

### Session summary

![The session-completion screen for the session that just ended.](/captures/session-summary.png)

### Plan builder

![The plan builder, showing a seeded workout template and the exercise catalog.](/captures/plan-builder.png)

## Open it

[Set it up and open it](/guides/dashboard-setup) covers the build step, the launch that
turns the dashboard on, and how to find its address. In short: call
[`server.health`](/reference/server) and open the `dashboardUrl` it returns. The port is
`7723` unless that port was busy, so read the address rather than typing it
(`src/tools/server-tools.ts:252`).

You can open the page at any point in a session. While a session is open, the server sends
its finished sets with every update, so a page opened or reloaded mid-session shows them
(`src/dashboard/spa/adapter.ts:755-766`). When the session ends, the live page clears its
set log; the session summary shows the finished session.

## How it stays current

The live page polls `/api/snapshot` every 2 seconds as a reconciliation backstop
(`POLL_INTERVAL_MS`, `src/dashboard/spa/main.tsx:63`), with `/api/stream` (SSE) layered
alongside it as the primary path for live phase/rep/velocity data and instant structural
pushes (`src/dashboard/spa/live-stream.ts`). The plan builder is on neither the poll nor the
stream cadence above. It re-polls `/api/plan-tree` on its own 2-second interval
(`src/dashboard/spa/planner/planner-client.ts:25`), so an exercise added over MCP
(`plan.exercise.create`) shows up without a reload.

## Tours

- [Live workout tour](/guides/dashboard-tour): each stage of the live page, from before a
  Voltra connects to the session summary and the two-device view.
- [Read the fatigue card](/guides/dashboard-fatigue): the fatigue card on a fresh set that
  reads Good, on a set that has slowed past the 20% line, and on the session summary.
- [Read pacing and form](/guides/dashboard-pacing-and-form): the tempo target and its light,
  the range-of-motion light, the rest stage's pace footer, and the two-device readout.
- [Review a session on the dashboard](/guides/dashboard-session-review): the verdict at the
  top of each exercise, the set it came from, and the load recommendation for next time.
- [Build a plan on the dashboard](/guides/dashboard-plan-builder): pick exercises from the
  catalog, set their targets, put them in order, and take them out again.

## For developers

- [Dashboard API](/reference/dashboard-api): the HTTP routes, the per-muscle and goal-coach
  response shapes, and the plan builder's write routes.
- [Dashboard pages](/reference/dashboard-pages): each route with the data it reads.
- [`docs/dashboard-drivers.md`](https://github.com/HJewkes/voltras-mcp/blob/main/docs/dashboard-drivers.md):
  the real device and four ways to make the live page render a workout without hardware,
  from a scripted fake state to a replay of a real recording, and what each one can show.
- [Try it without a device](/start/try-without-a-device): run the mock driver end to end.
