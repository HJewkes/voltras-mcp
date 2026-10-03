---
diataxis: explanation
audience: [lifter, coach]
status: coming-soon
statusNote: 'Goals: declared priorities with committed and stretch bands, weekly trajectory and bodyweight and attendance cards. The tools that set goals work, but the page has only been exercised on seeded data. The current block week and unreviewed-history notice are served but not yet shown.'
tracking: VW-514 (internal tracker)
sources:
  - src/dashboard/spa/goals/GoalsPage.tsx
  - src/dashboard/spa/goals/GoalsRoute.tsx
  - src/dashboard/spa/goals/use-goals-poll.ts
  - src/dashboard/spa/goals/goals-client.ts
  - src/dashboard/spa/goals/calibration-copy.ts
  - src/dashboard/spa/goals/whole-body-cards.ts
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/server.ts
  - src/docs/preview-seeds.ts
  - src/docs/capture-shots.ts
  - scripts/dashboard-mock-drive.mjs
  - scripts/dashboard-preview.mjs
  - src/dashboard/__tests__/preview-seeds.test.ts
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Goals page

The goals page is the `#/goals` page of the wall dashboard. It shows the priorities you
declared with your coach, the committed and stretch bands for each target, a week-by-week
trajectory chart, and whole-body cards for bodyweight and training days.

The goal tools themselves work today. `goal.declare_priorities`, `goal.propose_targets` and
`goal.accept_target` set goals, and `profile.log_bodyweight` logs a weigh-in. This page is only
about the wall page that draws them.

## What the page shows <Badge type="warning" text="Coming soon" />

The page asks the dashboard for your priorities, then for each priority's progress, every
2 seconds (`src/dashboard/spa/goals/use-goals-poll.ts:19-47`,
`src/dashboard/spa/goals/goals-client.ts:30-55`). If one priority's progress fails to load,
only that priority shows nothing; the rest of the page still draws
(`src/dashboard/spa/goals/goals-client.ts:44-51`).

- **A card per lift goal**, with how far you are from the goal, your best set, and a
  trajectory chart against the planned band.
- **Calibrating.** A new goal starts on a planned ramp, not on your own lifts, and the card
  says what it is waiting for before it calibrates
  (`src/dashboard/spa/goals/calibration-copy.ts:16-34`).
- **Whole body.** Bodyweight and training-day cards. The section is left out when you have no
  whole-body goal (`src/dashboard/spa/goals/whole-body-cards.ts:27-31`).

## Why it is not ready yet <Badge type="warning" text="Coming soon" />

**It has only been exercised on seeded data.** The published screenshots come from a scripted
run on the mock adapter. That run drives the real goal tools, but first writes a prior week's
set straight into the store so there is something to beat
(`scripts/dashboard-mock-drive.mjs:241-280`, `src/docs/capture-shots.ts:146-163`). The other
goal states you can preview are all seeded into a scratch store
(`src/docs/preview-seeds.ts:8-18`). Nobody has yet checked the page after declaring and
accepting a real goal.

**Two things are served but not shown.** The dashboard sends the current block week and a
count of history you have not reviewed yet (`src/dashboard/server.ts:1053-1059`). The page
keeps the block week but does not draw it yet, and drops the review count
(`src/dashboard/spa/goals/use-goals-poll.ts:27-31`, `src/dashboard/spa/goals/GoalsRoute.tsx:1-7`).
So the page cannot yet tell you which block week you are in, or that some sessions are left
out of its counts until you review them. That work is VW-514.

## What the screenshots show <Badge type="warning" text="Coming soon" />

Both captures come from the seeded run described above, not from a real session.

<CaptureCallouts
  shot="goals"
  :callouts='[
    {"quote": "CABLE CHEST PRESS", "text": "The card for the lift you declared as your priority."},
    {"quote": "Calibrating", "text": "The goal is still on its planned ramp, not yet on your own lifts."},
    {"quote": "Goal 8 x 123 lb", "text": "The target for the end of the block."},
    {"quote": "Best 8 x 110 lb", "text": "Your best set of the block so far."},
    {"quote": "13 lb to goal", "text": "How far that best set is from the target."},
    {"quote": "PER-LIFT", "text": "Smaller cards for your other lifts. The priority lift is never listed here."}
  ]'
/>

_Seeded preview data, not a real session._

<CaptureCallouts
  shot="goals-whole-body"
  :callouts='[
    {"quote": "WHOLE BODY", "text": "Left out of the page when you have no whole-body goal."},
    {"quote": "196.2", "text": "The latest weigh-in, set against the band for this week during a cut."},
    {"quote": "Training days", "text": "Days trained in the last 28, against the commitment you made."}
  ]'
/>

_Seeded preview data, not a real session._

## Preview it without a device <Badge type="warning" text="Coming soon" />

You can open this page on your own machine with no Voltra and no workout. Build once, then
start the preview:

```sh
npm run build && npm run build:dashboard
npm run dashboard:preview -- goals
```

The command starts a mock-adapter server on a scratch store, seeds it, and prints the page
address. Open that address in a browser. Press Ctrl-C to stop; that also deletes the scratch
store. Your real store at `~/.voltras/vmcp.sqlite` is never opened
(`scripts/dashboard-preview.mjs:1-8`, `scripts/dashboard-preview.mjs:34-37`,
`scripts/dashboard-preview.mjs:164-176`).

The preview does not replay the run behind the screenshots. It writes a history straight into
the scratch store and lets the real goal read model work out the rest
(`src/docs/preview-seeds.ts:8-18`). With no other arguments, it seeds a lift goal that is on
track (`scripts/dashboard-preview.mjs:57`, `src/dashboard/__tests__/preview-seeds.test.ts:143-144`).
The page you see can therefore differ from the screenshots above.
