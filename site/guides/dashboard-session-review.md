---
diataxis: tutorial
audience: [lifter, coach]
status: available
sources:
  - src/dashboard/spa/planner/SessionSummaryPage.tsx
  - src/dashboard/spa/planner/summary/
  - src/dashboard/spa/planner/session-summary-model.ts
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/spa/routing.ts
  - src/dashboard/read-models/session-summary.ts
  - src/dashboard/read-models/session-summary-view.ts
  - src/tools/plan-tools.ts
  - src/docs/capture-shots.ts
  - scripts/dashboard-plan-drive.mjs
lastVerified: 2026-10-15
sourced: 2026-10-15
---

# Review a session on the dashboard

This tutorial walks you through the session summary page after a workout. You open it, read
the verdict at the left of each exercise, check the sets behind it, and read the load for next
time on the right. It assumes the dashboard is already open; if it is not, start with
[Set it up and open it](/guides/dashboard-setup).

The capture below comes from a scripted run on the mock adapter. The summary shows the last
exercise of that run: two sets of Cable Chest Fly, five reps each at 140 lb, against a plan
that asks for 12 to 15 reps (`src/docs/capture-shots.ts:424-446`<!-- anchor: name: 'session-summary' -->,
`scripts/dashboard-plan-drive.mjs`).

## 1. Open the summary

Click **review** in the nav rail. It opens `#/summary`
(`src/dashboard/spa/panels/DashboardChrome.tsx`).

With no session named, the page shows the session that ended most recently, looking among the
20 that started most recently. If none of those has ended, it shows the one that started most
recently, the title reads "Session in progress" instead of "Session complete", and a "Session
still open" tag replaces the duration (`src/dashboard/read-models/session-summary.ts:114-144`<!-- anchor: LATEST_SCAN_LIMIT -->,
`src/dashboard/spa/planner/summary/SummaryHeader.tsx`).

The page loads once and does not poll, because a finished session's numbers do not change
(`src/dashboard/spa/planner/SessionSummaryPage.tsx:14-15`<!-- anchor: does not poll -->). If you opened it on a session in
progress, reload the page after [`session.end`](/reference/session) to see the final numbers.

<CaptureCallouts
  shot="session-summary"
  :callouts='[
    {"quote": "Session complete", "text": "The session has ended. A session still running reads Session in progress."},
    {"quote": "1 exercise · 2 sets · 10 reps · 1,400 lb", "text": "Totals for the whole session, across every exercise, then its duration."},
    {"quote": "Cable Chest Fly HOW IT MOVED · WORST SET #2 · VL12% Good VEL ROM TEMPO", "text": "The verdict for this exercise, the set it read and that set’s velocity loss."},
    {"quote": "VL 12%→12% e1RM 163→163 · 0% #1 5 140 lb VL12% #2 5 140 lb VL12%", "text": "The sets behind the verdict: velocity loss and estimated one-rep max from first set to last, then one column per set."},
    {"quote": "NEXT TIME · REPS VS PLAN 135 lb Back off 5 lb 2×12–15 5 5 Moved well · missed reps", "text": "The load for next time, the step that lands on it, and the reps it scored against the plan."},
    {"quote": "Cable Chest Fly #1 working 5 140 lb 12% 0.5 163 lb #2 working 5 140 lb 12% 0.5 163 lb", "text": "One row per set: what it counted as, reps, load, velocity loss, best rep velocity and estimated one-rep max."}
  ]'
/>

## 2. Read the totals

The header counts the whole session: exercises, sets, reps, volume and duration. Volume leaves
out sets with no load, such as band or damper sets, and says how many it left out
(`src/dashboard/spa/planner/session-summary-model.ts`, `headerTotals`). Below it, the page
draws one band per exercise the session touched, so a session that moved between lifts shows
each one (`src/dashboard/spa/planner/SessionSummaryPage.tsx:4-7`<!-- anchor: One band per exercise the session TOUCHED -->).

The **LBS / KG** toggle in the header switches every load on the page. In kg, a step such as
"Back off 3 kg" is the difference between the two loads shown, so it always adds up.

## 3. Read the verdict

Each band opens on the left with the fatigue verdict: the same word and the same three lights
the live page shows mid-set (`src/dashboard/spa/planner/summary/VerdictColumn.tsx`). The line
above the word names the set it read and that set's velocity loss. The verdict reads the
exercise's worst working set, measured by velocity loss
(`src/dashboard/read-models/session-summary-view.ts:80-86`<!-- anchor: Worst within-set velocity loss -->). On a tie it reads the later set
(`src/dashboard/read-models/session-summary.ts:279-284`<!-- anchor: Ties go to the LATER set -->). What the verdict words mean is
explained in [Fatigue and pacing](/concepts/fatigue-and-pacing).

With no verdict, the band says why instead: no working sets to score, or no bar-speed data.
Hover the label for the reason.

**There is no effort number yet.** "RIR · Calibrating" in the header marks it: the page shows
no RPE and no reps in reserve until the lifter has a fitted effort profile the dashboard can
trust. Hover it for the reason. That work is VW-485; see
[Effort readout](/coming-soon/effort-readout).

## 4. Check the sets behind it

The middle of the band gives two facts and then the sets. The facts are the velocity loss of
the first working set and the last, and the estimated one-rep max over the same sets
(`src/dashboard/spa/planner/summary/EvidenceColumn.tsx`). Each set then gets a column: its
number, reps, load and velocity loss. Warm-ups, and working sets the recommendation did not
score, are greyed and labelled.

## 5. Read the recommendation

The right of the band gives next time's load in large type, and the step that lands on it:
"Add 5 lb", "Hold" or "Back off 5 lb". The load is the heaviest working load of this session
plus the step (`src/dashboard/spa/planner/session-summary-model.ts:32-39`<!-- anchor: export function nextLoad -->). The step is never
coloured as an alarm. Hover it for the rule's own reasoning; in kg that text keeps its lb
numbers and says so.

Under the load, the plan's sets and rep range and one chip per scored set show the reps the
recommendation counted. A chip with an arrow up reached the top of the range; an arrow down
fell short of it.

The step comes from the same rule that [`plan.suggest_progression`](/reference/plan) runs
(`src/tools/plan-tools.ts:1750-1756`<!-- anchor: session-completion screen computes its -->, `src/dashboard/read-models/session-summary.ts:422`<!-- anchor: computeProgressionDelta(planned, args.sets, args.sessionId) -->).
The page runs that rule with a default intermediate tier and no diet phase. The tool reads
your own tier and declared diet phase, so the two can disagree
(`src/tools/plan-tools.ts:1127-1130`<!-- anchor: tier: 'intermediate' -->, `src/tools/plan-tools.ts:1620-1625`<!-- anchor: readDietPhaseState(state) -->). By default the
tool also reads the most recent session that trained the exercise, while the page reads the
session on screen. When they do, ask Claude for the tool's answer.

When the verdict and the step point opposite ways, a short label says so, for example "Moved
well · missed reps" (`src/dashboard/spa/planner/session-summary-model.ts:83-99`<!-- anchor: export function disagreement -->). It also
shows your usual rep range at this load, once your history has enough sets for one, and flags a
load whose effort has drifted from the plan. Hover any of these for the detail.

The recommendation needs a plan. The band reads "No recommendation" when the sets named no
exercise, when there is no active training program, or when the current program does not
prescribe the exercise; hover it for which
(`src/dashboard/read-models/session-summary.ts:398-419`<!-- anchor: No active training program -->). To get one, build the workout first:
see [Build a plan on the dashboard](/guides/dashboard-plan-builder).

## 6. Read the set table

Below the bands, a table lists every set of the session by exercise: what it counted as, reps,
load, velocity loss, best rep velocity and estimated one-rep max
(`src/dashboard/spa/planner/summary/SetRecordTable.tsx`).

## 7. Open an older session

`#/summary/<sessionId>` opens the summary for one session by its id
(`src/dashboard/spa/routing.ts`). Ask Claude to call [`session.list`](/reference/session)
for the ids of recent sessions, then type the address: for example `/app#/summary/` followed
by the id.
