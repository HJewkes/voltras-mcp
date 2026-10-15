---
diataxis: explanation
audience: [lifter, coach]
status: coming-soon
statusNote: 'Body map: weekly sets per muscle against population volume landmarks, per-muscle strength trend and planned-vs-done. Tapping a muscle opens a side sheet with its last-trained line. It is built, but so far it has only been shown on seeded data. Landmarks are population defaults, not yours.'
tracking: VW-918 (internal tracker)
sources:
  - src/dashboard/spa/body/BodyPage.tsx
  - src/dashboard/spa/body/body-client.ts
  - src/dashboard/spa/body/BodyView.tsx
  - src/dashboard/spa/body/body-sheet-model.ts
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/read-models/muscle-set-scope.ts
  - src/dashboard/read-models/muscle-week.ts
  - src/dashboard/read-models/muscle-recovery.ts
  - src/dashboard/muscle-strength-api.ts
  - src/dashboard/server.ts
  - scripts/dashboard-body-seed.mjs
  - src/docs/capture-shots.ts
  - src/docs/preview-seeds.ts
  - scripts/dashboard-preview.mjs
lastVerified: 2026-10-15
sourced: 2026-09-30
---

# Body map

The body map is the `#/body` page of the wall dashboard. It shows how many working sets each
muscle got this week, which lifts are getting stronger, and what your plan still owes. The
page is in the dashboard's side rail as "body" (`src/dashboard/spa/panels/DashboardChrome.tsx:44-52`).

## What the page shows <Badge type="warning" text="Coming soon" />

The page asks the dashboard for four things every 2 seconds, all at once, and shows three of
them (`src/dashboard/spa/body/BodyPage.tsx:30-38`). The fourth, recovery, appears only in the muscle side sheet, described
[below](#recovery-the-last-trained-line).

- **This week.** Working sets per muscle, set against volume landmarks, from
  `/api/muscle-week` (`src/dashboard/spa/body/body-client.ts:32-34`, `src/dashboard/spa/body/BodyView.tsx:290-316`).
- **Recent PRs.** Each lift's best estimated one-rep max over 12 weeks and its trend, from
  `/api/muscle-strength` (`src/dashboard/spa/body/body-client.ts:36-38`, `src/dashboard/spa/body/BodyView.tsx:262-287`). Left and right sides
  get separate trends, never an average (`src/dashboard/muscle-strength-api.ts:14-18`).
- **Next up.** The planned sets your current program week still owes, from `/api/muscle-plan`
  (`src/dashboard/spa/body/BodyView.tsx:233-259`).

## Why it is not ready yet <Badge type="warning" text="Coming soon" />

Every picture of this page so far comes from seeded data. The published screenshot below is
made by writing a plausible training week straight into the store, not by lifting
(`scripts/dashboard-body-seed.mjs:1-17`, `src/docs/capture-shots.ts:182-195`). Nobody has yet
checked the page after a real session on a real Voltra.

The mock adapter cannot fill this page either. Only your own working sets count: a set is left
out when it has a guest lifter, came from the mock adapter, is not a working set, or has no reps
(`src/dashboard/read-models/muscle-set-scope.ts:59-63`). So with `VOLTRA_ADAPTER=mock` the page
stays empty, on purpose.

Three more things can leave the page empty after real training:

- A set only counts toward a muscle when the set is tied to a known exercise
  (`src/dashboard/read-models/muscle-set-scope.ts:81-89`). Name the exercise with
  `session.set_exercise` before you lift.
- The page always shows the current week (`src/dashboard/spa/body/body-client.ts:32-34`,
  `src/dashboard/server.ts:961-967`). If you have not trained this week, the figure is blank.
- Next up is empty unless a program week is active today
  (`src/dashboard/server.ts:886-890`, `src/dashboard/spa/body/body-client.ts:45-54`).

<CaptureCallouts
  shot="body-week"
  :callouts='[
    {"quote": "SETS 28 MUSCLES 5 PRODUCTIVE 1", "text": "This week at a glance: working sets, muscles trained, and muscles in the productive zone."},
    {"quote": "Chest 15/14", "text": "A muscle past the top of the range that helps most."},
    {"quote": "Biceps 3/10", "text": "A muscle still under the fewest sets that help."},
    {"quote": "Cable Lat Pulldown Pull B 4 sets", "text": "Next up: what the current program week still owes, one row per lift."},
    {"quote": "Cable Chest Press Chest 221.7 lb (+12.7)", "text": "A recent PR: the best estimated one-rep max for the lift, and its change."}
  ]'
/>

_Seeded preview data, not a real session._

## Preview it without a device <Badge type="warning" text="Coming soon" />

You can open this page on your own machine with no Voltra and no workout. Build once, then
start the preview:

```sh
npm run build && npm run build:dashboard
npm run dashboard:preview -- body
```

The command starts a server on a scratch store, seeds it with the same training week as the
screenshot above, and prints the page address. Open that address in a browser. Press Ctrl-C
to stop; that also deletes the scratch store. Your real store at `~/.voltras/vmcp.sqlite` is
never opened (`scripts/dashboard-preview.mjs:1-8`, `scripts/dashboard-preview.mjs:40-42`,
`scripts/dashboard-preview.mjs:160-161`, `scripts/dashboard-preview.mjs:183-191`, `src/docs/preview-seeds.ts:89-94`).

The preview can fill this page only because it writes recorded sets into the store. Mock sets
never count on this page, so a mock-adapter workout leaves it empty
(`src/dashboard/read-models/muscle-set-scope.ts:59-63`).

## Landmarks are population defaults <Badge type="warning" text="Coming soon" />

The landmarks on this page are weekly set counts: the fewest sets that still help a muscle
grow, the range that helps most, and the most you can recover from. They are the same numbers
for everyone. They are copied reference values, not numbers
learned from your training (`src/dashboard/read-models/muscle-week.ts:17-21`,
`src/dashboard/read-models/muscle-week.ts:61-78`). The page says so under This week
(`src/dashboard/spa/body/BodyView.tsx:309-312`). Read a muscle's colour as "how this week compares
to a typical lifter," not as "how this week compares to what you can recover from."

Landmarks fitted to you do not exist yet. That is a known limitation (VW-146), not something
this page is waiting on.

## Recovery: the last-trained line <Badge type="warning" text="Coming soon" />

Tapping a muscle opens a side sheet over the figures
(`src/dashboard/spa/body/BodyView.tsx:166-168`, `src/dashboard/spa/body/BodyView.tsx:216-227`).
Recovery shows up there as a "Last trained" line, built from `/api/muscle-recovery`
(`src/dashboard/server.ts:690-693`, `src/dashboard/spa/body/body-sheet-model.ts:107`). The line
states what happened, when you last trained the muscle and how that session went against the
one before, and never a recovery verdict or a countdown
(`src/dashboard/spa/body/body-sheet-model.ts:66-68`). It does not say how long a muscle needs
before you can train it again, because no per-muscle number for that exists to cite
(`src/dashboard/read-models/muscle-recovery.ts:9-20`). The
[dashboard API reference](/reference/dashboard-api) describes what it returns.

## What is still open <Badge type="warning" text="Coming soon" />

Two gates remain before this page leaves coming soon:

- One check of the page after a real session on a real Voltra.
- VW-918: the per-day grouping and the week label still use UTC days, not your local days.
