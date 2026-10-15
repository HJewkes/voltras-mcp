---
title: Dashboard pages
description: One row per wall dashboard page, with its status, its route, how to open it and the read-model endpoints it calls.
diataxis: reference
audience: [lifter, coach, developer]
status: available
sources:
  - src/dashboard/spa/routing.ts
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/spa/main.tsx
  - src/dashboard/spa/live-stream.ts
  - src/dashboard/spa/planner/planner-client.ts
  - src/dashboard/spa/goals/goals-client.ts
  - src/dashboard/spa/body/body-client.ts
  - src/server.ts
  - src/dashboard/read-models/muscle-set-scope.ts
  - src/dashboard/read-models/session-summary.ts
  - src/dashboard/spa/live-page/stage-variant.ts
  - src/dashboard/spa/live-page/RestView.tsx
  - src/dashboard/spa/live-page/ExerciseHeader.tsx
  - src/tool-registry.ts
  - src/tools/truecoach-tools.ts
  - src/dashboard/spa/checkin/CheckinPage.tsx
  - src/dashboard/spa/checkin/CheckinSteps.tsx
  - src/dashboard/spa/goals/review-copy.ts
  - src/actions/allowlist.ts
lastVerified: 2026-10-15
---

# Dashboard pages

The wall dashboard is a local web page that the server starts beside the MCP transport. Ask
`server.health` for `dashboardUrl`: it names the port the dashboard actually bound, which is
`7723` unless that port was busy or `VMCP_DASHBOARD_PORT` says otherwise. Each page below is a
hash route, so you open it by adding the route to that URL, for example
`http://127.0.0.1:7723/app#/plan`. An unknown route opens the live page.

The status words are the ones defined on the [page status](/status) page. A page marked
Coming soon is built, but it is not usable end to end yet; its status word links to the page
that says what does not work.

| Status                                 | Route       | How to open it                                                                          | Read-model endpoints                                                              |
| -------------------------------------- | ----------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Available                              | `#/`        | The dashboard URL itself, or **live** in the nav rail.                                  | `/api/snapshot` (polled), `/api/stream` (server-sent events), `/api/session-plan` |
| Available                              | `#/plan`    | **plan** in the nav rail.                                                               | `/api/plan-tree`, `/api/exercises`; edits go to `/api/plan/*`                     |
| Available                              | `#/summary` | **review** in the nav rail, for the latest session; `#/summary/:sessionId` for another. | `/api/session-summary/:sessionId`                                                 |
| [Coming soon](/coming-soon/goals-page) | `#/goals`   | **goals** in the nav rail.                                                              | `/api/goals`, `/api/goal-progress`                                                |
| Available                              | `#/checkin` | **check-in** in the nav rail.                                                           | none; each step posts to `/api/actions/:name`                                     |
| [Coming soon](/coming-soon/body-map)   | `#/body`    | **body** in the nav rail.                                                               | `/api/muscle-week`, `/api/muscle-strength`, `/api/muscle-plan`                    |

## What each page shows

**Live (`#/`).** The current set as it happens, with velocity loss and form and tempo lights
against the set's stop threshold. Under the prescription it shows the effort target for a
working set: the plan's RPE as written, else the target for your training tier, marked
"(assumed tier)" when no tier was declared. Hover it for what the target rests on. A session
with no plan shows no target. The page does not show an effort estimate (RPE or reps in
reserve) read off the set yet.

**Plan builder (`#/plan`).** Browse the exercise catalog, then build, change or reorder a
workout. Lifts a coach adds with the `plan.*` tools appear without a reload, because the page
polls. Edits from the page need the dashboard's write token, which the page fetches for itself.

**Session summary (`#/summary`).** A per-exercise fatigue verdict, form lights and the worst
velocity loss for one session. It does not show an effort estimate yet.

**Goals (`#/goals`), coming soon.** Declared priorities with their committed and stretch
bands, the weekly trajectory, and bodyweight and attendance cards. The `goal.*` tools that set
goals are available; the page itself has only been exercised on seeded data so far. When some
past days are not yet marked as training or test, the page says its numbers leave them out.

**Check-in (`#/checkin`).** The weekly check-in as four steps: your bodyweight with an
optional note, three ratings for the week (hunger, diet plan adherence and sleep), the weekly
bodyweight review, where you accept, decline or put off any proposal it makes, and a done
screen. Each step
writes through an allowlisted MCP tool (`profile.log_bodyweight`,
`profile.log_weekly_checkin`, `goal.weekly_review`); nothing on the page calls Claude.

**Body (`#/body`), coming soon.** Weekly sets per muscle against volume landmarks, a strength
trend per muscle, and planned against done for the current week. It has only been shown on
seeded data so far. The landmarks are population defaults, not values fitted to you. Sets
recorded against the mock adapter never count on this page.

## Capability to screen

Each row names the tools whose calls put something on a screen. The status word is the same
one the table above gives for that route.

| Screen             | Route       | Status                                 | What you see                                                                                                                          | Tools that put it there                                                                                                                                                                                                    |
| ------------------ | ----------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live, during a set | `#/`        | Available                              | The device, the current set, velocity against the set's stop line, the fatigue card, the load, the prescription and its effort target | `device.connect`, `session.start`, `set.start` (or auto-arm on your own reps), `device.set_weight` for the load, `plan.attach_to_session` for the prescription and its RPE, `profile.set_training_background` for the tier |
| Live, resting      | `#/`        | Available                              | The set you just finished with its effort target, its verdict, the rest ring and the pace footer                                      | `set.end`; the ring counts down the rest the attached plan sets for the lift, else a default                                                                                                                               |
| Live, two devices  | `#/`        | Available                              | Left and right velocity on one chart                                                                                                  | `device.connect` once with `slot` set to `left` and once to `right`; `slot.bind` remembers each device's side                                                                                                              |
| Session summary    | `#/summary` | Available                              | A fatigue verdict per exercise, form lights, the worst velocity loss and a progression recommendation                                 | `session.start`, `set.start` and `set.end` for the sets; `plan.program.create` and `plan.exercise.create` for the recommendation, which needs the exercise prescribed in the current program                               |
| Plan builder       | `#/plan`    | Available                              | The exercise catalog and the workout editor                                                                                           | `plan.program.create`, `plan.template.create`, `plan.exercise.create`, `truecoach.import_week`, and the page's own edits                                                                                                   |
| Check-in           | `#/checkin` | Available                              | Your bodyweight, three ratings for the week and the weekly bodyweight review, one step at a time                                      | The page's own taps, through `profile.log_bodyweight`, `profile.log_weekly_checkin` and `goal.weekly_review`; the review reads a bodyweight goal set with `goal.accept_target`                                             |
| Goals              | `#/goals`   | [Coming soon](/coming-soon/goals-page) | Priorities with committed and stretch bands, the weekly trajectory, and bodyweight and attendance cards                               | `goal.declare_priorities`, `goal.propose_targets`, `goal.accept_target`, `set.end`, `profile.log_bodyweight`, `profile.set_diet_phase`                                                                                     |
| Body               | `#/body`    | [Coming soon](/coming-soon/body-map)   | Weekly sets per muscle, a strength trend per muscle, and planned against done this week                                               | `set.end` on a real device, `session.set_exercise` to name the lift, `plan.exercise.create` for the week's planned sets, `profile.set_diet_phase`                                                                          |

The `goal.*` tools are available today. The Coming soon label on the Goals row is about the
page, not the tools.

### What never shows on a screen

Some tools answer only in the conversation, and no dashboard page reads what they return:
`report.session_results`, `report.weekly`, `metrics.compute`, `coaching.explain` and
`progression.get_for_exercise`. Ask for them in the chat.

For the endpoint shapes behind each screen, see the [dashboard API](/reference/dashboard-api).
