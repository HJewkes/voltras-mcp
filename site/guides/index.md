# Guides

## The wall dashboard, stage by stage

voltras-mcp ships a local web dashboard alongside the MCP server, so a workout is
something you can watch on a screen instead of only reading back through Claude.
[`server.health`](/reference/server) reports whether one is running for the current
session (`dashboardAvailable`/`dashboardUrl`) — it has no dedicated MCP resource of its
own. The captures below are all driven through the real tool pipeline against the mock
adapter (`VOLTRA_ADAPTER=mock`), never a real device, so the numbers on them are
reproducible rather than a one-off recording.

### Before a Voltra connects

Nothing is bound yet: no [`device.connect`](/reference/device) has succeeded on this
slot, so the dashboard has no telemetry to show and says so plainly instead of leaving a
panel blank.

![The wall dashboard before a Voltra is connected.](/captures/dashboard-cold.png)

### Mid-set, with a plan attached

Once [`session.start`](/reference/session) opens a session pinned to an exercise and
[`plan.attach_to_session`](/reference/plan) has hung a prescription off it, the live
page shows the target rep band and load next to what the set is actually doing —
per-rep velocity, the fatigue verdict, and each rep's concentric/eccentric shape and
tempo.

![The live page mid-set, with the prescribed sets, reps, load and tempo attached.](/captures/live-mid-set.png)

### Between sets

Closing a set with [`set.end`](/reference/set) moves the dashboard into its rest stage:
the set just finished, its verdict, and a countdown ring driven by the exercise's
planned rest target — or, when no target is set, an honest count-up instead.

![The rest stage between two sets of a planned exercise.](/captures/live-rest.png)

### Session complete

[`session.end`](/reference/session) closes the session — force-ending any set still
open — and writes its final row. The summary page it produces reads back the totals,
speaks the same fatigue-verdict language the live page used mid-set, and adds RIR and a
load recommendation that only appear here.

![The session-completion screen for the session that just ended.](/captures/session-summary.png)

### Building the plan behind it

The prescriptions shown above come from the [`plan.*`](/reference/plan) namespace —
programs, blocks, weeks, and the planned exercises attached to a workout template. The
same dashboard exposes a builder view over that data.

![The plan builder, showing a workout template with three planned exercises and a searchable exercise catalog.](/captures/plan-builder.png)

### Two Voltras, one dashboard

A bilateral rig runs two devices on the `left` and `right` [slots](/reference/slot),
settable together with [`bilateral.cascade`](/reference/bilateral). The dashboard's
diverging stage plots both sides' per-rep velocity against each other so an imbalance
is visible mid-set, not just after the fact.

![The diverging stage mid-set, with two Voltras bound to the left and right slots.](/captures/live-dual-mid-set.png)
