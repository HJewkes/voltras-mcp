# The wall dashboard

This page is about the sidecar itself — what it is, how to find it, its three pages, and
how it stays current. For what each page actually looks like mid-workout, see the
[dashboard walkthrough](/guides/) on the guides index; that page carries the captures, this
one doesn't repeat them.

## What it is

voltras-mcp starts a local HTTP sidecar alongside the MCP transport: `127.0.0.1` only, no
network exposure beyond the machine it runs on (`README.md`). Its live-view routes —
`/api/snapshot`, `/api/stream`, `/api/history`, `/api/session-plan`, `/api/exercises`,
`/api/plan-tree`, `/api/session-summary/:sessionId` — are all reads. That's the surface the
README calls "read-only," and it's the one this guide is mostly about.

It isn't read-only end to end, though: the plan builder page writes through a small REST
surface of its own — `POST /api/plan/programs`, `POST /api/plan/templates/:id/exercises`,
`PATCH /api/plan/exercises/:id`, and more — implemented as a second thin adapter over the
same `SessionStore` methods the `plan.*` MCP tools call, not a reimplementation
(`src/dashboard/README.md`). There's deliberately no delete route, because `SessionStore`
has no planning delete either. So: the live view is read-only; the plan builder is not.

## Finding its URL

The port defaults to **7723**, set by `VMCP_DASHBOARD_PORT`; `off` or `0` disables the
sidecar entirely. If that port is already held — another session's server got there first —
the sidecar binds an OS-assigned port instead of failing, so don't assume 7723. Read
`dashboardUrl` from [`server.health`](/reference/server) instead, and give it to the user
verbatim; `dashboardAvailable` is `false` and `dashboardDisabledReason` explains why when
there's nothing to point at (`README.md`, `site/reference/server.md`).

## The three pages

The SPA hash-routes, since the sidecar serves one static `index.html` with no server-side
fallback (`src/dashboard/README.md`):

| URL             | Page                                                                        |
| --------------- | ---------------------------------------------------------------------------- |
| `/app` or `/app#/` | The live page — the wall display, deliberately chrome-free.               |
| `/app#/plan`     | The plan builder: browse the exercise catalog, see the workout being planned, edit it by hand. |
| `/app#/summary`  | The session-completion screen for the most recent session; `#/summary/<sessionId>` pins a specific one. |

`/` redirects to `/app`. `?variant=live` / `?variant=live-dual` pins the single or diverging
live-page stage for testing; without it, the page picks the stage from live state — which
limb slots are bound (`src/dashboard/README.md`).

## How it stays current

The live page polls `/api/snapshot` every 2 seconds as a reconciliation backstop
(`POLL_INTERVAL_MS`, `src/dashboard/spa/main.tsx:61`), with `/api/stream` (SSE) layered
alongside it as the primary path for live phase/rep/velocity data and instant structural
pushes (`src/dashboard/spa/live-stream.ts`). The plan builder is on neither the poll nor the
stream cadence above — it re-polls `/api/plan-tree` on its own 2-second interval, so an
exercise added over MCP (`plan.exercise.create`) shows up without a reload
(`src/dashboard/README.md`).

The set log on the live page accumulates client-side from live transitions — a set is
logged when the active set goes non-null → null across two polls. **Open the page before or
during a run**: a browser that connects after the last set has nothing to show
(`README.md`).

## Driving it without hardware

Four ways to get the dashboard rendering a workout sit on a fidelity ladder from a scripted
fake state object up to a real Voltra, each trading setup cost against what it can prove —
a real device, `dashboard-sim` (no MCP server, no SDK), `dashboard-mock-drive` (the real MCP
server in mock mode, driven through real tools), and `dashboard-plan-drive` (the same, plus
a real plan attached). See
[`docs/dashboard-drivers.md`](https://github.com/HJewkes/voltras-mcp/blob/main/docs/dashboard-drivers.md)
for the full comparison table — what each one can and can't show for prescription,
bilateral, and timers — rather than this page restating it. The
[first-session guide](/guides/first-session#option-b-without-a-device) and the
[bilateral guide](/guides/bilateral#no-hardware-or-only-one-device-the-dual-mock-path) both
walk through running `dashboard-mock-drive.mjs` end to end.

## What to read next

- The [dashboard walkthrough](/guides/) for the captures — before connection, mid-set, the
  rest stage, session summary, the plan builder, and the bilateral diverging stage.
- [`docs/dashboard-drivers.md`](https://github.com/HJewkes/voltras-mcp/blob/main/docs/dashboard-drivers.md)
  for the full driver comparison.
- The [`server.*` reference](/reference/server) for `dashboardAvailable`/`dashboardUrl`.
