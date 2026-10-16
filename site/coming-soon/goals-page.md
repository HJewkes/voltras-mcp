---
diataxis: explanation
audience: [lifter, coach]
status: coming-soon
statusNote: 'Goals: declared priorities with committed and stretch bands, weekly trajectory and bodyweight and attendance cards. The tools that set goals work, but the page has only been exercised on seeded data. The unreviewed-days note is shown; the current block week header is served but not yet drawn.'
tracking: VW-655, VW-901, VW-360 (internal tracker)
sources:
  - src/dashboard/spa/goals/GoalsPage.tsx
  - src/dashboard/spa/goals/GoalsRoute.tsx
  - src/dashboard/spa/goals/GoalsView.tsx
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
lastVerified: 2026-10-15
sourced: 2026-09-30
---

# Goals page

The goals page is the `#/goals` page of the wall dashboard. It shows the priorities you
declared with your coach, the committed and stretch bands for each target, a week-by-week
trajectory chart, and whole-body cards for bodyweight and training days.

The page is in the dashboard's side rail as "Goals"
(`src/dashboard/spa/panels/DashboardChrome.tsx:55-59`).

The goal tools themselves work today. `goal.declare_priorities`, `goal.propose_targets` and
`goal.accept_target` set goals, and `profile.log_bodyweight` logs a weigh-in. This page is only
about the wall page that draws them.

## What the page shows <Badge type="warning" text="Coming soon" />

The page asks the dashboard for your priorities, then for each priority's progress, every
2 seconds (`src/dashboard/spa/goals/use-goals-poll.ts:26-47`,
`src/dashboard/spa/goals/goals-client.ts:32-57`). If one priority's progress fails to load,
only that priority shows nothing; the rest of the page still draws
(`src/dashboard/spa/goals/goals-client.ts:44-55`).

- **A card per lift goal**, with how far you are from the goal, your best set, and a
  trajectory chart against the planned band.
- **Calibrating.** A new goal starts on a planned ramp, not on your own lifts, and the card
  says what it is waiting for before it calibrates
  (`src/dashboard/spa/goals/calibration-copy.ts:21-38`).
- **Whole body.** Bodyweight and training-day cards. The section is left out when you have no
  whole-body goal (`src/dashboard/spa/goals/whole-body-cards.ts:27-33`).

## Why it is not ready yet <Badge type="warning" text="Coming soon" />

**It has only been exercised on seeded data.** The published screenshots come from a scripted
run on the mock adapter. That run drives the real goal tools, but first writes a prior week's
set straight into the store so there is something to beat
(`scripts/dashboard-mock-drive.mjs:241-280`, `src/docs/capture-shots.ts:163-179`). The other
goal states you can preview are all seeded into a scratch store
(`src/docs/preview-seeds.ts:8-18`). Nobody has yet checked the page after declaring and
accepting a real goal; that check waits on your first declared priority (VW-360).

**The unreviewed-days count is shown.** When some days are left out of the counts until you
review them, a line at the top of the page says how many
(`src/dashboard/spa/goals/GoalsView.tsx:86`, `src/dashboard/spa/goals/GoalsView.tsx:96-98`).
A page that lets you review those days so they count is VW-901.

**The block week is served but not drawn.** The dashboard sends the current block week
(`src/dashboard/server.ts:1093-1098`), and the page chrome has a slot for a header, but the
goals route passes none (`src/dashboard/spa/goals/GoalsRoute.tsx:14-20`). So the page cannot
yet tell you which block week you are in as a header. Each goal card already shows its own
week cells. The header is VW-655.

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
(`scripts/dashboard-preview.mjs:1-8`, `scripts/dashboard-preview.mjs:40-42`,
`scripts/dashboard-preview.mjs:160-161`,
`scripts/dashboard-preview.mjs:183-191`).

The preview does not replay the run behind the screenshots. It writes a history straight into
the scratch store and lets the real goal read model work out the rest
(`src/docs/preview-seeds.ts:8-18`). With no other arguments, it seeds a lift goal that is on
track (`scripts/dashboard-preview.mjs:61`, `src/dashboard/__tests__/preview-seeds.test.ts:144-148`).
The page you see can therefore differ from the screenshots above.
