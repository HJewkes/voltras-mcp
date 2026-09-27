---
title: Velocity and effort
description: What bar speed tells you about how hard a set was, and why the server will not turn it into an RIR or RPE number until it has a curve fitted to you.
diataxis: explanation
audience: [lifter, coach]
status: available
sources:
  - src/analytics/rir-velocity.ts
  - src/state/event-bridge.ts
  - src/tools/rir-velocity-tools.ts
  - src/tools/metrics-tools.ts
  - src/tools/report-tools.ts
  - src/state/velocity-loss-intent.ts
  - src/state/effort-context.ts
  - src/store/rir-velocity-candidates.ts
  - src/store/sqlite-store.ts
  - src/dashboard/spa/live-page/fatigue-state.ts
  - src/dashboard/spa/panels/fatigue-view.ts
  - src/dashboard/read-models/session-summary.ts
  - src/dashboard/spa/planner/SessionSummaryPage.tsx
  - src/config.ts
  - docs/failure-anchor-harvest.md
  - package.json
lastVerified: 2026-09-27
---

# Velocity and effort

This page explains what the speed of your reps says about effort. It also explains why the server
is careful about turning speed into an effort number.

Three terms first.

- **VBT** is velocity-based training: using how fast you move the load to guide training.
- **RIR** is reps in reserve: how many more reps you could have done when you stopped.
- **RPE** is rating of perceived exertion: how hard a set felt.

## What the server measures

The Voltra streams readings of the cable as you move, and the server groups them into reps
(`src/state/event-bridge.ts:22-25`). The number this server leans on most is
**mean concentric velocity**. That is the average speed of the lifting part of a rep, in metres
per second. The fitted effort curve described below reads this number and no other
(`src/analytics/rir-velocity.ts:52-60`).

**Velocity loss** is how much slower your reps have become within one set. It is a percentage.
The per-set summary in [`metrics.compute`](/reference/metrics) reports it on mean velocity
(`src/tools/metrics-tools.ts:2414`, `src/tools/metrics-tools.ts:2248-2249`). Some internal readings compare peak speeds instead. Those
give a different percentage for the same set, and both are correct for their own question
(`src/tools/metrics-tools.ts:2248-2251`).

## Why slowing down tracks effort

As a set goes on, fatigue builds and each rep gets slower. So a bigger velocity loss usually means
you are closer to failure. The server's failure check, for example, treats a 30% loss as the band
where failure gets close
([failure-anchor-harvest.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/failure-anchor-harvest.md#the-criterion-version-failure-harvest100)).
The server uses velocity loss in two places.

First, velocity loss is a stop signal during a set. The server treats the stopping point as a
goal choice, not a fixed number. A strength set defaults to a 20% loss, a hypertrophy set to 30%
and a power set to 10% (`src/state/velocity-loss-intent.ts:45-49`). Research on velocity-loss
thresholds found that loss size barely changed strength gains, while higher loss favoured muscle
growth (`src/state/velocity-loss-intent.ts:3-10`). That research used barbell lifts, so the server
treats these defaults as starting points on a cable device, not as fixed facts
(`src/state/velocity-loss-intent.ts:17-20`).

Second, velocity is how the server spots a set that already reached failure. That process is
described under [Where the curve comes from](#where-the-curve-comes-from).

## Why a general formula is not enough

It is tempting to convert velocity loss straight into RIR with one formula for everyone. The
server does not trust that. Its own tool description cites a 2023 study that found agreement
between velocity loss and RIR "unacceptable at every load tested" for a general model
(`src/tools/metrics-tools.ts:2427-2433`).

What works better is a curve fitted to one lifter on one exercise. A 2024 study found individual
curves predicted a later session within under two reps of error across 70% to 90% of 1RM. General
curves failed at 70%, which is where most working sets sit
(`src/analytics/rir-velocity.ts:5-12`, `src/tools/rir-velocity-tools.ts:8-11`).

So the server keeps one curve per lifter per exercise. It is a straight line: velocity against
reps in reserve (`src/analytics/rir-velocity.ts:20-32`).

## Where the curve comes from

[`rir_velocity.fit`](/reference/rir_velocity) builds the curve from your own recorded sets
(`src/tools/rir-velocity-tools.ts:37-48`). A set only counts if it meets all of these:

- It was done at a constant load, with no chains, eccentric or damper setting
  (`src/tools/rir-velocity-tools.ts:38-39`).
- Its load was between 70% and 90% of your estimated 1RM (`src/analytics/rir-velocity.ts:173-174`).
- Something says how many reps you had left when it ended (`src/store/rir-velocity-candidates.ts:4-9`).

A fit also needs at least 3 such sets, from at least 2 sessions, giving at least 12 rep points. The
points must span at least 3 reps of RIR, and speed must rise as RIR rises
(`src/analytics/rir-velocity.ts:181-208`). If the fit misses a minimum, it deletes any older
curve rather than leave a stale one readable (`src/tools/rir-velocity-tools.ts:46-47`).

How does the server know how many reps you had left? Mostly from **failure anchors**. When a set
closes, the server checks whether it already ended in a genuine stall
(`docs/failure-anchor-harvest.md`). The set needs at least four reps. Its last rep must be at or
below 70% of the speed of its fastest rep after the first. The last three reps must slow steadily,
and the last rep's range of motion must be no more than 35% below the set's typical rep
([failure-anchor-harvest.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/failure-anchor-harvest.md#the-criterion-version-failure-harvest100)).
That last rep is then RIR 0 (`src/store/rir-velocity-candidates.ts:116-126`).

The server never asks you to train to failure. It only labels sets that stalled anyway. A
cautious lifter may never produce an anchor, and the design accepts that
([failure-anchor-harvest.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/failure-anchor-harvest.md#harvest-never-prescribe)).
A slow last rep with no steady slowdown before it is labelled an abort, not a failure. Stopping
early because something hurt can look like a stall but gives a falsely fast anchor. That would tell
you that you had reps left when you did not
([failure-anchor-harvest.md](https://github.com/HJewkes/voltras-mcp/blob/main/docs/failure-anchor-harvest.md#why-the-decay-trajectory-is-a-hard-filter)).

## Self-reported RIR

A set can also count if you said how many reps you had left. The curve reader accepts that
self-report, and a measured failure outranks it on the same set
(`src/store/rir-velocity-candidates.ts:116-126`). A self-report anchors the curve less firmly,
because lifters rate the same measured speed differently
(`src/store/rir-velocity-candidates.ts:15-20`).

Today no tool records a per-set self-reported RIR. The reader exists, but nothing writes the value
it reads (VW-499). The one place that writes an anchor row is the failure harvest, and it stores no
self-report (`src/store/sqlite-store.ts:5617-5634`, `src/store/sqlite-store.ts:6773-6792`). So in
practice every curve rests on failure anchors.

## When the server will state a number

The server is strict here, because an effort number is the claim most easily over-read.

[`rir_velocity.target`](/reference/rir_velocity) turns an RIR prescription into your own velocity
target. With no fitted curve it returns no number. It returns a caveat instead, and says it will
not substitute a group curve (`src/tools/rir-velocity-tools.ts:50-59`, `src/tools/rir-velocity-tools.ts:155-163`).
With a curve, it also says whether the answer lies outside the range the curve was fitted over
(`src/tools/rir-velocity-tools.ts:52-54`).

A curve is **trusted** only when its error is 1.5 reps or less and it was fitted under the current
model version (`src/analytics/rir-velocity.ts:62-80`). That limit is tighter than the study's
two-rep figure on purpose (`src/analytics/rir-velocity.ts:62-66`).

The optional effort cue asks for more. It uses a curve only if it also has a failure anchor,
predicted a held-out set within 1.5 reps, was fitted in the last 42 days, and came from
constant-load sets (`src/analytics/rir-velocity.ts:108-124`, `src/state/effort-context.ts:229-241`).
That cue is off by default (`src/config.ts:299`).

The per-set RIR reading in [`metrics.compute`](/reference/metrics) always answers, but it says
which curve answered. With no fitted curve it uses a general formula, grades its model confidence
low, and carries the same caveat (`src/tools/rir-velocity-tools.ts:216-240`,
`src/tools/metrics-tools.ts:2427-2440`). Read that as a rough direction, not a rep count.

[`report.weekly`](/reference/report) includes a final-rep RIR line only when the RIR feature's
baseline gate allows it. The line names its basis, for example "general model, not a
proximity-to-failure read" (`src/tools/report-tools.ts:564-600`).

## What the dashboard shows today

The live fatigue card shows velocity loss against your set's stop threshold
(`src/dashboard/spa/panels/fatigue-view.ts:477`, `src/dashboard/spa/live-page/fatigue-state.ts:1-10`).
It also shows a verdict built from velocity loss, range of motion and tempo
(`src/dashboard/spa/panels/fatigue-view.ts:432-435`).
It shows no RPE or RIR. Both are withheld until a trusted fitted profile reaches the wall
(`src/dashboard/spa/panels/fatigue-view.ts:428-431`).

The session summary works the same way. It shows each exercise's fatigue verdict and velocity
figures, and states no RIR or RPE (`src/dashboard/read-models/session-summary.ts:10-14`,
`src/dashboard/spa/planner/SessionSummaryPage.tsx:201-202`).

## Where the maths lives

The velocity summaries and fatigue verdicts come from
[`@voltras/workout-analytics`](https://www.npmjs.com/package/@voltras/workout-analytics), the
published analytics library this server depends on (`package.json:63`). The per-lifter curve, its
trust rules and the failure harvest live in this repo (`src/analytics/rir-velocity.ts`,
`src/store/rir-velocity-candidates.ts`).

For how far to trust each number on this page, see [Calibration and trust](/concepts/calibration-and-trust).
