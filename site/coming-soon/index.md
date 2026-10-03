---
diataxis: overview
audience: [lifter, coach, developer]
status: available
sources:
  - site/status.md
  - src/dashboard/spa/body/BodyPage.tsx
  - src/dashboard/spa/goals/GoalsPage.tsx
  - src/dashboard/spa/panels/fatigue-view.ts
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Coming soon

The pages in this section describe wall-dashboard screens that are built in the code and that
you can open, but that you cannot rely on yet. Each one is not yet exercised end to end on real
session data, is fed by population defaults rather than numbers about you, or holds its number
back until the server has a model fitted to you. Each page says which, in a note under its
title.

These pages carry the **Coming soon: not yet usable** status. The [status page](/status)
defines it and the other two statuses.

| Page                                          | Dashboard route      | What is missing                                                                           | Tracking                  |
| --------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- | ------------------------- |
| [Body map](/coming-soon/body-map)             | `#/body`             | Only shown on seeded data so far; landmarks are population defaults; recovery has no page | VW-146 (internal tracker) |
| [Goals page](/coming-soon/goals-page)         | `#/goals`            | Only exercised on seeded data so far; block week not shown                                | VW-514 (internal tracker) |
| [Effort readout](/coming-soon/effort-readout) | `#/` and `#/summary` | RPE and RIR held back until a trusted curve fitted to you exists                          | VW-485 (internal tracker) |

The [Roadmap](/roadmap) is the wider list of things present in the code that do not yet do
what their name suggests. The issue tracker is authoritative: when this section and the
tracker disagree, trust the tracker.
