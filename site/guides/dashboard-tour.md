---
diataxis: tutorial
audience: [lifter, coach]
status: available
sources:
  - src/tools/server-tools.ts
  - src/docs/capture-shots.ts
  - src/docs/capture-clips.ts
  - scripts/dashboard-plan-drive.mjs
  - src/dashboard/spa/live-page/LivePage.tsx
  - src/dashboard/spa/live-page/RestView.tsx
  - src/dashboard/spa/planner/SessionSummaryPage.tsx
lastVerified: 2026-09-28
---

# Live workout tour

This tour walks the live page of the wall dashboard through one planned workout: before a
Voltra connects, mid-set, between sets, the session summary, and the two-device view. The
numbered legend under a capture names a string on that capture and says what it means.
[`server.health`](/reference/server) reports whether a dashboard is running for the current
session (`dashboardAvailable`/`dashboardUrl`); [set it up and open it](/guides/dashboard-setup)
covers the rest.

Every capture here is driven through the real tool pipeline against the mock adapter
(`VOLTRA_ADAPTER=mock`), never a real device, so the numbers are reproducible rather than a
one-off recording. The planned workout is seeded by `scripts/dashboard-plan-drive.mjs`: a
program called Mock Hypertrophy whose Push A workout holds Cable Chest Press 3 × 8–10 at
140 lb, then two more exercises (`scripts/dashboard-plan-drive.mjs:115-126`).

## Before a Voltra connects

Nothing is bound yet: no [`device.connect`](/reference/device) has succeeded on this slot, so
the dashboard has no telemetry to show and says so plainly instead of leaving a panel blank.

![The wall dashboard before a Voltra is connected.](/captures/dashboard-cold.png)

## Mid-set, with a plan attached

Once [`session.start`](/reference/session) opens a session pinned to an exercise and
[`plan.attach_to_session`](/reference/plan) has hung a prescription off it, the live page shows
the prescription next to what the set is actually doing.

<CaptureCallouts
  shot="live-mid-set"
  :callouts='[
    {"quote": "Cable Chest Press 3 × 8–10 @ 140 lbs", "text": "The prescription from the attached plan: sets, rep range and load."},
    {"quote": "0/8 sets", "text": "Working sets done out of every set the plan holds for this session."},
    {"quote": "VL 20% VL 30% 0.50 0.49 0.47 0.46", "text": "Each rep as a bar on the velocity chart, drawn against lines at 20% and 30% velocity loss."},
    {"quote": "FATIGUE — RPE Good", "text": "The fatigue verdict. The RPE slot shows a dash: the effort readout is coming soon."}
  ]'
/>

The RPE slot stays a dash until a trusted fitted effort profile exists for the lifter
(`src/dashboard/spa/panels/fatigue-view.ts:428-431`). The
[effort readout](/coming-soon/effort-readout) page says what is missing. The
[fatigue tour](/guides/dashboard-fatigue) follows this card from Good to a slowing set.

## Between sets

Closing a set with [`set.end`](/reference/set) moves the live page into its rest stage.

<CaptureCallouts
  shot="live-rest"
  :callouts='[
    {"quote": "SET VERDICT 5 Reps 140 lbs 12%", "text": "The set just finished: reps, load and velocity loss."},
    {"quote": "SET REPS LBS RPE 1 5 140 —", "text": "The set log. RPE is a dash here too."},
    {"quote": "Next · Cable Chest Press · set 2 of 3", "text": "What the plan has next."},
    {"quote": "VOLUME 5 TONNAGE 700 lbs", "text": "The session so far: reps, and reps times load."},
    {"quote": "1/8 sets", "text": "One working set done out of eight planned."}
  ]'
/>

The countdown ring runs down the rest the plan set for this exercise, or a goal default
labelled "Default rest" when the plan sets none (`src/dashboard/spa/live-page/RestView.tsx:208-238`).
The [pacing and form tour](/guides/dashboard-pacing-and-form) covers the ring and the pace
footer.

## A planned set, narrated

This clip runs a working set on the live page with the plan prescription attached. It is
driven the same way as the captures above.

<video controls preload="metadata" width="100%" src="/captures/clips/planned-set.mp4" title="A working set on the live page, with the plan prescription attached."></video>

The narration is synthetic speech, generated from a script in this repository. Edit
[`planned-set.narration.txt`](https://github.com/HJewkes/voltras-mcp/blob/main/site/guides/planned-set.narration.txt)
and re-run `npm run docs:captures` to change what it says
([`docs/screenshot-harness.md`](https://github.com/HJewkes/voltras-mcp/blob/main/docs/screenshot-harness.md)).

## Session complete

[`session.end`](/reference/session) closes the session, force-ending any set still open, and
writes its final row. The summary page reads back the totals, uses the same fatigue verdict the
live page showed mid-set, and adds a load recommendation that only appears here. It states no
RPE or RIR (`src/dashboard/spa/planner/SessionSummaryPage.tsx:201-202`).

![The session-completion screen for the session that just ended.](/captures/session-summary.png)

## The plan behind it

The plan builder has its own entry in the [dashboard overview](/guides/dashboard#plan-builder).

## Two Voltras, one dashboard

A bilateral rig runs two devices on the `left` and `right` [slots](/reference/slot), settable
together with [`bilateral.cascade`](/reference/bilateral). The diverging stage plots both sides'
per-rep velocity against each other, so an imbalance is visible mid-set, not just after the
fact. The [pacing and form tour](/guides/dashboard-pacing-and-form#left-and-right) reads it.

![The diverging stage mid-set, with two Voltras bound to the left and right slots.](/captures/live-dual-mid-set.png)
