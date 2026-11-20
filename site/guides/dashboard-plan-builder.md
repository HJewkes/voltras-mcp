---
diataxis: how-to
audience: [lifter, coach]
status: available
sources:
  - src/dashboard/spa/planner/PlanBuilderPage.tsx
  - src/dashboard/spa/planner/planner-client.ts
  - src/dashboard/spa/planner/target-fields.ts
  - src/dashboard/read-models/plan-tree.ts
  - src/dashboard/plan-api.ts
  - src/dashboard/spa/panels/DashboardChrome.tsx
  - src/dashboard/spa/api-client.ts
  - src/dashboard/server.ts
  - src/dashboard/write-guard.ts
  - src/docs/capture-shots.ts
  - scripts/dashboard-plan-drive.mjs
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Build a plan on the dashboard

The plan builder is the dashboard page where you build a workout by hand: pick exercises from
the catalog, set their targets, put them in order, and take them out again. It edits the same
plan data that Claude edits with the [`plan.*`](/reference/plan) tools, and the prescription
the live page shows mid-set comes from that data. This page assumes the dashboard is open; if
it is not, start with [Set it up and open it](/guides/dashboard-setup).

<CaptureCallouts
  shot="plan-builder"
  :callouts='[
    {"quote": "30 exercises", "text": "The catalog on the left, with how many exercises match the current search."},
    {"quote": "Push A Block 1 · Week 1 · 3 exercises completed", "text": "A workout in the Workouts list, with its block, week, exercise count and a completed badge."},
    {"quote": "Push A — planned exercises", "text": "The editor for the selected workout."},
    {"quote": "1. Cable Chest Press 3 × 8-10 · @ 140 lb · 90s rest", "text": "One planned exercise: sets, rep range, load and rest."},
    {"quote": "Save targets", "text": "Saves the sets, reps and load you typed for that exercise."}
  ]'
/>

The capture comes from a scripted run on the mock adapter, with the workout written by the
`plan.*` tools before the shot (`src/docs/capture-shots.ts:446-460`<!-- anchor: name: 'plan-builder' -->,
`scripts/dashboard-plan-drive.mjs:248-271`<!-- anchor: plan.program.create -->).

## Open the builder

Click **plan** in the nav rail. It opens `#/plan`
(`src/dashboard/spa/panels/DashboardChrome.tsx`).

## Pick or start a program

The Program bar at the top lists your programs. Select one to edit it, or type a name into
**New program name** and click **Create program**
(`src/dashboard/spa/planner/PlanBuilderPage.tsx:274-324`<!-- anchor: function ProgramBar -->). A new program comes with its first
block, week and workout (`src/dashboard/server.ts:87-88`<!-- anchor: POST /api/plan/programs -->).

To add another workout to the program, type a name into **New workout name** in the Workouts
panel and click **Add workout**. Click a workout to open it in the editor. The workout the live
session is attached to carries a "training now" badge. A workout with any session linked to it,
by [`plan.attach_to_session`](/reference/plan) or [`plan.complete_workout`](/reference/plan),
carries "completed", so the workout you are training can carry both
(`src/dashboard/spa/planner/PlanBuilderPage.tsx:460-545,564-606`<!-- anchor: training now -->,
`src/dashboard/read-models/plan-tree.ts:107-108`<!-- anchor: activeTemplateId: string | null -->, `src/dashboard/plan-api.ts:157-159`<!-- anchor: getAssignmentsForTemplate -->).

## Browse the catalog

The Exercise catalog panel lists every exercise. Type into **Search exercises** to narrow it
by name, or pick a muscle group from the filter. The caption under the filters counts the
matches (`src/dashboard/spa/planner/PlanBuilderPage.tsx:339-376`<!-- anchor: Search exercises -->).

## Build the workout

With a workout selected, click **Add** on a catalog row to append that exercise to the
workout. With no workout selected, the Add buttons are off and the caption says "select a
workout to add" (`src/dashboard/spa/planner/PlanBuilderPage.tsx:191-199`<!-- anchor: canAdd={templateId !== null && !busy} -->,
`src/dashboard/spa/planner/PlanBuilderPage.tsx:373-376`<!-- anchor: select a workout to add -->).

After a click, the button stays off until the new row is on screen. A double-click therefore
adds the exercise once, not twice (`src/dashboard/spa/planner/PlanBuilderPage.tsx:33-38`<!-- anchor: ref-guarded in-flight latch -->,
`src/dashboard/spa/planner/PlanBuilderPage.tsx:160-180`<!-- anchor: The RECONCILE runs inside the latch -->).

## Retarget an exercise

Each planned exercise has four boxes: sets, the low and high ends of the rep range, and the
load in pounds. Type into the ones you want to change and click **Save targets**. A blank box
leaves that target as it is. A box that is not a number, a value out of range, or a rep range
whose high end falls below its low end shows an error instead of saving (`src/dashboard/spa/planner/target-fields.ts:1-11`<!-- anchor: out-of-range -->, `src/dashboard/spa/planner/target-fields.ts:34-42`<!-- anchor: CROSS-field rule -->,
`src/dashboard/spa/planner/PlanBuilderPage.tsx:707-723`<!-- anchor: parseTargetFields( -->).

## Reorder the workout

Use the up and down arrows on a planned exercise to move it one place. There is no drag
handle (`src/dashboard/spa/planner/PlanBuilderPage.tsx:760-778`<!-- anchor: props.onUp?.() -->).

## Delete an exercise

Click the cross on a planned exercise, then click **Remove?** to confirm, or **Cancel** to
keep it (`src/dashboard/spa/planner/PlanBuilderPage.tsx:779-815`<!-- anchor: Remove? -->). The exercises below it move
up to close the gap (`src/dashboard/server.ts:93-94`<!-- anchor: DELETE /api/plan/exercises/:id -->).

## Changes Claude makes show up on their own

The builder asks the dashboard for the plan every 2 seconds. When Claude adds an exercise with
[`plan.exercise.create`](/reference/plan), it appears in the builder within about 2 seconds,
with no reload. The workout you have selected stays selected across those refreshes
(`src/dashboard/spa/planner/PlanBuilderPage.tsx:12-16`<!-- anchor: resolveSelectedTemplateId -->,
`src/dashboard/spa/planner/planner-client.ts:4-12`<!-- anchor: Why polling, not SSE -->,
`src/dashboard/spa/planner/planner-client.ts:24-25`<!-- anchor: PLANNER_POLL_INTERVAL_MS = 2000 -->).

## Why other pages cannot edit your plan

The plan builder is the one page that writes. Each of its edits needs a same-origin request
that carries a per-boot write token (`src/dashboard/server.ts:96-99`<!-- anchor: per-boot write token -->,
`src/dashboard/write-guard.ts:85-95`<!-- anchor: checkToken(headers.token, expectedToken) -->). A page from another site, open in a browser on the same
machine, cannot make that request, so it cannot change your plan
(`src/dashboard/write-guard.ts:3-31`<!-- anchor: What this defends against -->). The guard does not stop another program running as your
user, which can read the token the way it can read the store itself
(`src/dashboard/write-guard.ts:33-35`<!-- anchor: another process running as -->).

If the server restarts while the builder is open, your next edit picks up the new token and
tries once more, so you do not need to reload
(`src/dashboard/spa/api-client.ts:9-17`<!-- anchor: retries ONCE -->).
