# The wall dashboard

This page is about the sidecar itself — what it is, how to find it, its four pages, and
how it stays current. For what each page actually looks like mid-workout, see the
[dashboard walkthrough](/guides/) on the guides index; that page carries the captures, this
one doesn't repeat them.

## What it is

voltras-mcp starts a local HTTP sidecar alongside the MCP transport: `127.0.0.1` only, no
network exposure beyond the machine it runs on (`README.md`). Its live-view routes —
`/api/snapshot`, `/api/stream`, `/api/history`, `/api/session-plan`, `/api/exercises`,
`/api/plan-tree`, `/api/muscle-plan`, `/api/muscle-week`, `/api/muscle-strength`,
`/api/muscle-recovery`, `/api/goals`, `/api/goal-progress`, `/api/session-summary/:sessionId`
— are all reads. That's the surface the README calls "read-only," and it's the one this
guide is mostly about. `/api/muscle-plan` (VW-331) rolls up the active training week into
planned-vs-done working sets per titan muscle group (VW-328), plus the still-untrained
planned exercises per muscle. `/api/muscle-week` (VW-329) answers the adjacent question —
how much you actually trained each muscle this week, and whether that is a lot or a little.
`/api/muscle-strength` (VW-330) answers the third — which muscles are actually getting
stronger; it has [its own section below](#per-muscle-strength-api-muscle-strength).
`/api/muscle-recovery` (VW-332) answers the fourth: when you last trained each muscle, and
how that session went against the one before it. All four are internal plumbing for the
body-map page (VW-323), not surfaced on a page of their own yet. `/api/goals` and
`/api/goal-progress` (VW-352) are the equivalent plumbing for the `#/goals` page: what the
coach is tracking, and how each target is reading this week; see
[their own section below](#goal-coach-api-goals-api-goal-progress).

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

### `/api/muscle-recovery` — when you last trained each muscle

```json
{
  "muscleMapVersion": "2026-09-13.1",
  "muscles": [
    {
      "muscle": "chest",
      "lastTrainedAt": "2026-07-08T10:00:00.000Z",
      "daysSince": 2,
      "lastEntryDepression": { "pct": 6.1, "confidence": 0.5 },
      "lastSessionMatchedPrior": true,
      "reason": null
    }
  ]
}
```

All 15 titan muscle groups are always present. A muscle you haven't trained in the trailing
56 days reports nulls across the board rather than a stale date. `daysSince` is whole days
elapsed, so a muscle trained this morning reads `0`.

**This route computes no recovery window, and that is deliberate.** It will not tell you how
long a muscle needs before it is trainable again, because no such per-muscle number exists to
cite: the research behind this route looked, and found only training-frequency bands that
vary by training age and say nothing about you on a given day. A projected return-to-ready
moment would be a number nobody measured, dressed as a measurement. So you get what was
actually observed and the judgement stays yours.

What was observed is two things. `lastEntryDepression` is the entry-depression axis from
that last session — how far its opening working set sat below your own prior output at the
same load, which is the under-recovery read with actual support behind it. `pct` is a
percentage below; a negative value means you opened above your norm. `confidence` is the
axis's own coarse 0-to-1 self-assessment, for ordering rows, not for arithmetic. It is null
when the session had nothing at a matched load to compare its opener against, and it is
never a read on what you ate.

`lastSessionMatchedPrior` is the recovery performance benchmark: did that session's
heaviest set match or beat the previous **comparable** session's load times reps? Comparable
is the server's own like-vs-like test — same movement, same lifter, same intent, same side,
same device settings, same physical setup, same load, and the same training context (a
maintenance phase and a recomposition phase count as one). When no such pair exists the
answer is `null` and `reason` says which piece was missing: `insufficient history` (nothing
prior inside the window), `no matched-load prior` (you trained it, but at a different load —
the common case after moving the pin), or `no comparable prior` (something else changed).
The three are kept apart because they are not the same answer.

### Goal coach (`/api/goals`, `/api/goal-progress`)

`GET /api/goals` lists every declared priority (`goal.declare_priorities`) with its accepted
targets and a rollup verdict — `on_track`, `behind`, `stalled` and the rest, the most
actionable of the priority's own targets — computed the same way `GET /api/goal-progress`
computes one target's own status. A priority with nothing accepted yet reports `rollup:
null` rather than a verdict over zero targets.

`GET /api/goal-progress?priorityId=<id>` returns the full progress view for every non-retired
target under one priority: the weekly trajectory band, the committed and stretch edges you
accepted, this week's status and why, the entry-depression confounder when one is behind, and
— for a lift — the plateau read. An unknown or retired `priorityId` 404s the same
`{ "error": "not_found" }` shape `GET /api/plan-tree` does for a route with nothing to answer.

**The band shown is re-derived, never replayed.** Both routes re-run the same tier, diet-phase
and band arithmetic `goal.propose_targets` runs, off the target's own stored metric and
exercise, so the page can never show a trajectory the MCP tool path would disagree with. Only
the weekly corridor moves with a fresh derivation; the committed and stretch numbers stay the
fixed values you accepted (`src/store/types.ts`'s `StoredGoalTarget` — a target's own numbers
never move once accepted).

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

## The four pages

The SPA hash-routes, since the sidecar serves one static `index.html` with no server-side
fallback (`src/dashboard/README.md`):

| URL                | Page                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `/app` or `/app#/` | The live page — the wall display, deliberately chrome-free.                                             |
| `/app#/plan`       | The plan builder: browse the exercise catalog, see the workout being planned, edit it by hand.          |
| `/app#/summary`    | The session-completion screen for the most recent session; `#/summary/<sessionId>` pins a specific one. |
| `/app#/body`       | The body map: this week's volume per muscle, what the plan still owes, and recent PRs.                  |

![The body page: a training week's volume per muscle, what is due next, and recent PRs.](/captures/body-week.png)

`/app#/goals` is a fifth route with no rail entry yet — reachable by URL only, same as
`#/body` was before VW-338.

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

## Per-muscle strength (`/api/muscle-strength`)

One read answers "which muscles are getting stronger"; `#/body` renders its PR rows. For
each of the 15 body-map muscle slugs it returns the exercises whose **primary** muscle maps
to that slug, and for each one: the best e1RM in a 12-week window with its error band, the
fitted weekly slope, the plateau verdict, and whether the newest session was a personal
record. Only your own working sets with reps recorded count, never a guest's, never a
warm-up and never a mock-adapter set — the same scoping `/api/muscle-week` and
`/api/muscle-plan` apply, so the three never disagree. The slope is
`metrics.compute history.trend` (metric `e1rm`) run per exercise and per side, not a second
implementation of the same fit (`src/dashboard/muscle-strength-api.ts`).

Two rules shape the answer, and both exist to stop it over-claiming:

- **Left and right are never pooled.** A bilateral exercise returns one row per side. An
  average of two limbs is a display number; the per-side pair is the assessment reference
  (`src/analytics/side-comparison.ts`).
- **One exercise is never enough to say a muscle grew.** Each muscle carries an `agreement`
  flag — `stronger`, `weaker`, `mixed`, or `insufficient` — that names a direction only when
  at least two separate exercises trend the same way. It reports agreement of direction, not
  size: no published threshold says how big a load trend has to be to count, so none is
  applied. An `earlyPhase` flag marks a lifter with under six months of declared training,
  where a rising e1RM is as much skill as tissue; rows are flagged, never dropped.

The full response shape is in
[`src/dashboard/README.md`](https://github.com/HJewkes/voltras-mcp/blob/main/src/dashboard/README.md).

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

### Seeing a PR star on the goals page

`dashboard-mock-drive.mjs --goal=<exerciseId>` drives the whole goal-coach loop with no
device: it puts one working set in the previous week, declares that lift as a priority,
takes the coach's proposed band and accepts it, then drives a set at the current top load
and a heavier one after it. Open `#/goals` when it finishes and the target's card carries
the PR star, because the heavier set is the first reading in the window to pass every
earlier one.

```sh
npm run build && npm run build:dashboard
node scripts/dashboard-mock-drive.mjs --goal=cable-chest-press
# then open http://127.0.0.1:7724/app#/goals
```

The load each set is performed at is written with `device.set_weight` (`--load`, default
100 lb) and recorded on the set, so the same run also gives `goal.propose_targets` and
`history.trend` something to read. Use `--goal-pr-load` to choose how much heavier the
second set is.

## What to read next

- The [dashboard walkthrough](/guides/) for the captures — before connection, mid-set, the
  rest stage, session summary, the plan builder, and the bilateral diverging stage.
- [`docs/dashboard-drivers.md`](https://github.com/HJewkes/voltras-mcp/blob/main/docs/dashboard-drivers.md)
  for the full driver comparison.
- The [`server.*` reference](/reference/server) for `dashboardAvailable`/`dashboardUrl`.
