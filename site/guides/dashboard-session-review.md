---
diataxis: tutorial
audience: [lifter, coach]
status: available
sources:
  - src/dashboard/spa/planner/SessionSummaryPage.tsx
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/spa/routing.ts
  - src/dashboard/read-models/session-summary.ts
  - src/dashboard/read-models/session-summary-view.ts
  - src/tools/plan-tools.ts
  - src/docs/capture-shots.ts
lastVerified: 2026-09-28
---

# Review a session on the dashboard

This tutorial walks you through the session summary page after a workout. You open it, read
the verdict at the top of each exercise, check the set that verdict came from, and read the
load recommendation for next time. It assumes the dashboard is already open; if it is not,
start with [Set it up and open it](/guides/dashboard-setup).

The capture below comes from a scripted run on the mock adapter: two sets of Cable Chest
Press, five reps each at 140 lb, against a plan that asks for 8 to 10 reps
(`src/docs/capture-shots.ts:351-367`, `src/docs/capture-shots.ts:380`).

## 1. Open the summary

Click **review** in the nav rail. It opens `#/summary`
(`src/dashboard/spa/panels/DashboardChrome.tsx:34-39`).

With no session named, the page shows the session that ended most recently. If nothing has
ended yet, it shows the one that started most recently, and the title reads "Session in
progress" instead of "Session complete" (`src/dashboard/read-models/session-summary.ts:117-144`,
`src/dashboard/spa/planner/SessionSummaryPage.tsx:145-147`).

The page loads once and does not poll, because a finished session's numbers do not change
(`src/dashboard/spa/planner/SessionSummaryPage.tsx:9-10`). If you opened it on a session in
progress, reload the page after [`session.end`](/reference/session) to see the final numbers.

<CaptureCallouts
  shot="session-summary"
  :callouts='[
    {"quote": "Session complete", "text": "The session has ended. A session still running reads Session in progress."},
    {"quote": "EXERCISES 1 SETS 2 REPS 10 VOLUME 1400 lb", "text": "Totals for the whole session, across every exercise."},
    {"quote": "FATIGUE — RPE Good", "text": "The verdict for this exercise. The RPE label carries no number: the effort readout is coming soon (VW-485)."},
    {"quote": "12% peak-to-last within a set — set #2, the set the verdict above reads.", "text": "The worst velocity loss in any working set, and which set it was."},
    {"quote": "RECOMMENDATION -5 lb TARGET LOAD 135 lb", "text": "The load change for next time, and the load it lands on."},
    {"quote": "#1 5 × 140 lb loss 12% best 0.5 #2 5 × 140 lb loss 12% best 0.5", "text": "One row per set: reps, load, velocity loss and best rep velocity."}
  ]'
/>

## 2. Read the totals

The first card counts the whole session: exercises, sets, reps, volume and duration
(`src/dashboard/spa/planner/SessionSummaryPage.tsx:131-141`). Below it, the page draws one
card per exercise the session touched, so a session that moved between lifts shows each one
(`src/dashboard/spa/planner/SessionSummaryPage.tsx:4-7`).

## 3. Read the verdict

Each exercise card opens with the fatigue verdict: the same word and the same three lights
the live page shows mid-set (`src/dashboard/spa/planner/SessionSummaryPage.tsx:198-204`). The
verdict reads the exercise's worst working set, measured by velocity loss
(`src/dashboard/read-models/session-summary-view.ts:80-88`). What the verdict words mean is
explained in [Fatigue and pacing](/concepts/fatigue-and-pacing).

**There is no effort number yet.** The verdict has a slot for RPE, and it stays empty. The
page shows no RPE and no reps in reserve until the lifter has a fitted effort profile the
dashboard can trust (`src/dashboard/spa/planner/SessionSummaryPage.tsx:201-202`). That work is
VW-485; see [Effort readout](/coming-soon/effort-readout).

A PR badge on an exercise card means the best estimated one-rep max **of this session**. The
page only ever sees one session, so it cannot claim an all-time record
(`src/dashboard/spa/planner/SessionSummaryPage.tsx:193-195`).

## 4. Check the worst velocity loss

Under the tiles, a gauge shows the exercise's worst within-set velocity loss. The caption
under it names the set the verdict read, so you can check the two against each other
(`src/dashboard/spa/planner/SessionSummaryPage.tsx:205-227`). In the capture both sets lost
12%, and the verdict reads set 2.

When an exercise has at least two working sets with a recorded load, the card also plots its
estimated one-rep max across the session. With fewer, it says there is not enough to plot
(`src/dashboard/spa/planner/SessionSummaryPage.tsx:256-261`).

## 5. Read the recommendation

The "Next session" block gives a load change and the target load it lands on. The line under
the tiles says why (`src/dashboard/spa/planner/SessionSummaryPage.tsx:297-337`). It comes from
the same rule that [`plan.suggest_progression`](/reference/plan) runs
(`src/tools/plan-tools.ts:1555-1560`, `src/dashboard/read-models/session-summary.ts:410`).
The page runs that rule with a default intermediate tier and no diet phase. The tool reads
your own tier and declared diet phase, so the two can disagree
(`src/tools/plan-tools.ts:1012-1015`, `src/tools/plan-tools.ts:1500-1505`). When they do, ask
Claude for the tool's answer.

The recommendation needs a plan. Instead of tiles you get one line when the sets named no
exercise, when there is no active training program, or when the current program does not
prescribe the exercise (`src/dashboard/read-models/session-summary.ts:391-409`). To get one,
build the workout first: see [Build a plan on the dashboard](/guides/dashboard-plan-builder).

## 6. Read the set rows

The last block lists each set with its reps, load, velocity loss and best rep velocity.
Warm-up sets carry a "warm-up" tag (`src/dashboard/spa/planner/SessionSummaryPage.tsx:340-376`).

## 7. Open an older session

`#/summary/<sessionId>` opens the summary for one session by its id
(`src/dashboard/spa/routing.ts:53-57`). Ask Claude to call [`session.list`](/reference/session)
for the ids of recent sessions, then type the address: for example `/app#/summary/` followed
by the id.
