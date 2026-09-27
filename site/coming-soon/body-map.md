---
diataxis: explanation
audience: [lifter, coach]
status: coming-soon
statusNote: 'Body map: weekly sets per muscle against population volume landmarks, per-muscle strength trend and planned-vs-done. It is built, but so far it has only been shown on seeded data. Landmarks are population defaults, not yours.'
tracking: VW-146 (internal tracker)
sources:
  - src/dashboard/spa/body/BodyPage.tsx
  - src/dashboard/spa/body/body-client.ts
  - src/dashboard/spa/body/BodyView.tsx
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/read-models/muscle-set-scope.ts
  - src/dashboard/read-models/muscle-week.ts
  - src/dashboard/read-models/muscle-recovery.ts
  - src/dashboard/muscle-strength-api.ts
  - src/dashboard/server.ts
  - scripts/dashboard-body-seed.mjs
  - src/docs/capture-shots.ts
lastVerified: 2026-09-27
---

# Body map

The body map is the `#/body` page of the wall dashboard. It shows how many working sets each
muscle got this week, which lifts are getting stronger, and what your plan still owes. The
page is in the dashboard's side rail as "body" (`src/dashboard/spa/panels/DashboardChrome.tsx:38`).

## What the page shows

The page asks the dashboard for three things every 2 seconds, all at once
(`src/dashboard/spa/body/BodyPage.tsx:22-31`):

- **This week.** Working sets per muscle, set against volume landmarks, from
  `/api/muscle-week` (`src/dashboard/spa/body/BodyView.tsx:246`).
- **Recent PRs.** Each lift's best estimated one-rep max over 12 weeks and its trend, from
  `/api/muscle-strength` (`src/dashboard/spa/body/BodyView.tsx:219`). Left and right sides
  get separate trends, never an average (`src/dashboard/muscle-strength-api.ts:14-18`).
- **Next up.** The planned sets your current program week still owes, from `/api/muscle-plan`
  (`src/dashboard/spa/body/BodyView.tsx:190`).

## Why it is not ready yet

Every picture of this page so far comes from seeded data. The published screenshot below is
made by writing a plausible training week straight into the store, not by lifting
(`scripts/dashboard-body-seed.mjs:1-18`, `src/docs/capture-shots.ts:152-160`). Nobody has yet
checked the page after a real session on a real Voltra.

The mock adapter cannot fill this page either. Only your own working sets count: a set is left
out when it has a guest lifter, came from the mock adapter, is not a working set, or has no reps
(`src/dashboard/read-models/muscle-set-scope.ts:59-65`). So with `VOLTRA_ADAPTER=mock` the page
stays empty, on purpose.

Three more things can leave the page empty after real training:

- A set only counts toward a muscle when the set is tied to a known exercise
  (`src/dashboard/read-models/muscle-set-scope.ts:72-90`). Name the exercise with
  `session.set_exercise` before you lift.
- The page always shows the current week (`src/dashboard/spa/body/body-client.ts:29-31`,
  `src/dashboard/server.ts:908-910`). If you have not trained this week, the figure is blank.
- Next up is empty unless a program week is active today
  (`src/dashboard/server.ts:846-850`, `src/dashboard/spa/body/body-client.ts:37-45`).

![Preview, not yet available: the body page with a front and back muscle figure coloured by this week's sets, a Next up list, a Recent PRs list and a This week summary.](/captures/body-week.png)

_Seeded preview data, not a real session._

## Landmarks are population defaults

The landmarks on this page are weekly set counts: the fewest sets that still help a muscle
grow, the range that helps most, and the most you can recover from. They are the same numbers
for everyone. They are copied reference values, not numbers
learned from your training (`src/dashboard/read-models/muscle-week.ts:17-21`,
`src/dashboard/read-models/muscle-week.ts:61-77`). The page says so under This week
(`src/dashboard/spa/body/BodyView.tsx:257`). Read a muscle's colour as "how this week compares
to a typical lifter," not as "how this week compares to what you can recover from."

Landmarks fitted to you are coming. That work is VW-146.

## Recovery: computed, not on any page

Per-muscle recovery (when you last trained each muscle, and how that session went against the
one before) is computed by the dashboard at `/api/muscle-recovery`
(`src/dashboard/server.ts:967-971`). No page shows it: the body page never asks for it
(`src/dashboard/spa/body/BodyPage.tsx:24-31`). It also never says how long a muscle needs
before you can train it again, because no per-muscle number for that exists to cite
(`src/dashboard/read-models/muscle-recovery.ts:9-20`). The
[dashboard guide](/guides/dashboard)
describes what it returns.
