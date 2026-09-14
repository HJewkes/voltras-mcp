# The wall dashboard

This page is about the sidecar itself — what it is, how to find it, its three pages, and
how it stays current. For what each page actually looks like mid-workout, see the
[dashboard walkthrough](/guides/) on the guides index; that page carries the captures, this
one doesn't repeat them.

## What it is

voltras-mcp starts a local HTTP sidecar alongside the MCP transport: `127.0.0.1` only, no
network exposure beyond the machine it runs on (`README.md`). Its live-view routes —
`/api/snapshot`, `/api/stream`, `/api/history`, `/api/session-plan`, `/api/exercises`,
`/api/plan-tree`, `/api/muscle-plan`, `/api/muscle-week`, `/api/session-summary/:sessionId` —
are all reads. That's the surface the README calls "read-only," and it's the one this guide
is mostly about. `/api/muscle-plan` (VW-331) rolls up the active training week into
planned-vs-done working sets per titan muscle group (VW-328), plus the still-untrained
planned exercises per muscle. `/api/muscle-week` (VW-329) answers the adjacent question —
how much you actually trained each muscle this week, and whether that is a lot or a little.
Both are internal plumbing for the body-map page (VW-323), not surfaced on a page of their
own yet.

### `/api/muscle-week` — weekly sets per muscle

```json
{
  "weekStart": "2026-07-06T00:00:00.000Z",
  "muscleMapVersion": "2026-09-13.1",
  "landmarkBasis": "population-default",
  "muscles": [
    {
      "muscle": "chest",
      "sets": 9,
      "status": "maintenance",
      "landmarks": { "mev": 8, "mav": 14, "mrv": 20 },
      "lastTrainedAt": "2026-07-07T11:00:00.000Z"
    }
  ]
}
```

All 15 titan muscle groups are always present, with zeros for the ones you didn't train, so
a figure can paint every muscle rather than guessing at gaps. `?weekStart=` picks a week by
any ISO instant inside it; the default is the current week, which starts Monday 00:00 UTC —
the same boundary `history.weekly_volume` uses.

A set counts toward its exercise's **primary** muscle group only. Secondary groups
contribute nothing, at any weight: a chest press is chest volume, not chest volume plus a
half-share of triceps. Only your own working sets count — a guest's sets, warm-ups, and sets
where nothing was actually lifted are all left out. `lastTrainedAt` looks back further than
the week itself, so a muscle you last trained a fortnight ago still reports the date.

**`landmarkBasis` is always `population-default`, and that word matters.** MEV, MAV and MRV
here are population reference numbers copied from the titan design system, not numbers
discovered from your own training. Your actual landmarks can only come from watching how
your set counts and performance move across mesocycles, which voltras-mcp does not yet do
(VW-146). Until it does, read `status` as "how this week compares to a typical lifter," not
as "how this week compares to what you can recover from." `status` is one of `under`,
`maintenance`, `productive` or `over`, and the route never suggests adding sets or taking a
deload — set count is a fatigue dial, not a progression tool.

It isn't read-only end to end, though: the plan builder page writes through a small REST
surface of its own — `POST /api/plan/programs`, `POST /api/plan/templates/:id/exercises`,
`PATCH /api/plan/exercises/:id`, and more — implemented as a second thin adapter over the
same `SessionStore` methods the `plan.*` MCP tools call, not a reimplementation
(`src/dashboard/README.md`). That surface also includes `DELETE /api/plan/exercises/:id`,
which unplans one exercise and closes the gap it leaves in the template's order
(`src/dashboard/server.ts:65`, `SessionStore.deletePlannedExercise`,
`src/store/sqlite-store.ts:2534`, VW-121) — a plain delete of the planned row, not of any
session that was actually trained against it: the assignment linking a past session to that
plan entry falls back to unlinked rather than disappearing. So: the live view is read-only;
the plan builder is not.

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

| URL                | Page                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `/app` or `/app#/` | The live page — the wall display, deliberately chrome-free.                                             |
| `/app#/plan`       | The plan builder: browse the exercise catalog, see the workout being planned, edit it by hand.          |
| `/app#/summary`    | The session-completion screen for the most recent session; `#/summary/<sessionId>` pins a specific one. |

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
