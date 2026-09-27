---
diataxis: explanation
audience: [lifter, coach]
status: coming-soon
statusNote: 'Goals: declared priorities with committed and stretch bands, weekly trajectory and bodyweight and attendance cards. The tools that set goals work, but the page has only been exercised on seeded data and is reachable by URL only. The current block week and unreviewed-history notice are served but not yet shown.'
tracking: VW-514 (internal tracker)
sources:
  - src/dashboard/spa/goals/GoalsPage.tsx
  - src/dashboard/spa/goals/goals-client.ts
  - src/dashboard/spa/goals/calibration-copy.ts
  - src/dashboard/spa/goals/whole-body-cards.ts
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/server.ts
  - src/docs/preview-seeds.ts
  - src/docs/capture-shots.ts
  - scripts/dashboard-mock-drive.mjs
lastVerified: 2026-09-27
---

# Goals page

The goals page is the `#/goals` page of the wall dashboard. It shows the priorities you
declared with your coach, the committed and stretch bands for each target, a week-by-week
trajectory chart, and whole-body cards for bodyweight and training days.

The goal tools themselves work today. `goal.declare_priorities`, `goal.propose_targets` and
`goal.accept_target` set goals, and `profile.log_bodyweight` logs a weigh-in. This page is only
about the wall page that draws them.

## What the page shows

The page asks the dashboard for your priorities, then for each priority's progress, every
2 seconds (`src/dashboard/spa/goals/GoalsPage.tsx:24-30`,
`src/dashboard/spa/goals/goals-client.ts:24-49`). If one priority's progress fails to load,
only that priority shows nothing; the rest of the page still draws
(`src/dashboard/spa/goals/goals-client.ts:41-45`).

- **A card per lift goal**, with how far you are from the goal, your best set, and a
  trajectory chart against the planned band.
- **Calibrating.** A new goal starts on a planned ramp, not on your own lifts, and the card
  says what it is waiting for before it calibrates
  (`src/dashboard/spa/goals/calibration-copy.ts:18-35`).
- **Whole body.** Bodyweight and training-day cards. The section is left out when you have no
  whole-body goal (`src/dashboard/spa/goals/whole-body-cards.ts:27-31`).

## Why it is not ready yet

**It has only been exercised on seeded data.** The published screenshots come from a scripted
run on the mock adapter. That run drives the real goal tools, but first writes a prior week's
set straight into the store so there is something to beat
(`scripts/dashboard-mock-drive.mjs:236-258`, `src/docs/capture-shots.ts:133-146`). The other
goal states you can preview are all seeded into a scratch store
(`src/docs/preview-seeds.ts:8-18`). Nobody has yet checked the page after declaring and
accepting a real goal.

**It is reachable by URL only.** The side rail has no goals entry, so you have to type
`/app#/goals` (`src/dashboard/spa/panels/DashboardChrome.tsx:34-39`,
`src/dashboard/spa/panels/DashboardChrome.tsx:55-58`).

**Two things are served but not shown.** The dashboard sends the current block week and a
count of history you have not reviewed yet (`src/dashboard/server.ts:1051-1056`). The page
keeps only the priorities and drops both (`src/dashboard/spa/goals/GoalsPage.tsx:26-30`). So
the page cannot yet tell you which block week you are in, or that some sessions are left out
of its counts until you review them. That work is VW-514.

![Preview, not yet available: the goals page with a Cable Chest Press card marked Calibrating, a trajectory chart rising toward the goal, and two smaller per-lift cards.](/captures/goals.png)

_Seeded preview data, not a real session._

![Preview, not yet available: the Whole body section of the goals page, with a bodyweight card during a cut and a training-days card for the last 28 days.](/captures/goals-whole-body.png)

_Seeded preview data, not a real session._
