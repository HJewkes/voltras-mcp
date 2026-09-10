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
per-rep velocity, the fatigue verdict, and where in the concentric/eccentric phase the
current rep sits.

![The live page mid-set, with the prescribed sets, reps, load and tempo attached.](/captures/live-mid-set.png)

### Between sets

Closing a set with [`set.end`](/reference/set) moves the dashboard into its rest stage:
the set just finished, its verdict, and — when [`VMCP_REST_TIMER`](/install-and-run#environment-variables)
is armed — a countdown to the next one.

![The rest stage between two sets of a planned exercise.](/captures/live-rest.png)

### Session complete

[`session.end`](/reference/session) is what actually persists the session and triggers
derivation; the summary page it produces reads back the totals, the same fatigue and
RIR verdicts shown mid-set, and a load recommendation for next time.

![The session-completion screen for the session that just ended.](/captures/session-summary.png)

### Building the plan behind it

The prescriptions shown above come from the [`plan.*`](/reference/plan) namespace —
programs, blocks, weeks, and the planned exercises attached to a workout template. The
same dashboard exposes a builder view over that data.

![The plan builder, showing a seeded workout template and the exercise catalog.](/captures/plan-builder.png)

### Two Voltras, one dashboard

A bilateral rig runs two devices on the `left` and `right` [slots](/reference/slot),
settable together with [`bilateral.cascade`](/reference/bilateral). The dashboard's
diverging stage plots both sides' per-rep velocity against each other so an imbalance
is visible mid-set, not just after the fact.

![The diverging stage mid-set, with two Voltras bound to the left and right slots.](/captures/live-dual-mid-set.png)
