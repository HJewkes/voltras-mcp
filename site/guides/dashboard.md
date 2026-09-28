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
  - docs/dashboard-drivers.md
  - site/public/captures/manifest.json
lastVerified: 2026-09-28
---

# The wall dashboard

The wall dashboard is a local web page that voltras-mcp starts beside the MCP server. Put it
on a screen you can see from the machine: it shows the set you are doing as you do it, the
session when you finish, and the plan behind it. Claude still runs the workout; the dashboard
shows what the server records.

![The live page mid-set, with the prescribed sets, reps, load and tempo attached.](/captures/live-mid-set.png)

## What it is

- **Local.** The dashboard binds `127.0.0.1` only, so you open it on the machine that runs the
  server and no other machine can reach it (`src/dashboard/server.ts:242`).
- **One per session.** Each Claude Code session runs its own server, and each server starts
  its own dashboard on its own port (`src/server.ts:145-157`).
- **Mostly read-only.** The live page and the session summary only read. The plan builder is
  the one page that writes, and each of its edits needs a same-origin request that carries a
  per-boot write token (`src/dashboard/server.ts:96-99`, `src/dashboard/write-guard.ts:85-95`).
- **No effort number yet.** The live page and the session summary show velocity loss and a
  fatigue verdict, but no RPE or reps in reserve. The
  [effort readout](/coming-soon/effort-readout) is coming soon.

Every capture on this site comes from the real MCP tools running against the mock adapter
(`VOLTRA_ADAPTER=mock`), not from a real Voltra (`src/docs/capture-shots.ts`).

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

Open the page before the first set. The set log on the live page builds up in the browser as
sets close, so a page opened after the last set has nothing to show (`README.md:262`).

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
  four ways to make the dashboard render a workout without hardware, from a scripted fake
  state up to a real Voltra, and what each one can show.
- [Try it without a device](/start/try-without-a-device): run the mock driver end to end.
