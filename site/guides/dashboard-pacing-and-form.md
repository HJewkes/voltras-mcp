---
diataxis: tutorial
audience: [lifter, coach]
status: available
sources:
  - src/docs/capture-shots.ts
  - scripts/dashboard-plan-drive.mjs
  - src/dashboard/tempo-defaults.ts
  - src/dashboard/spa/panels/fatigue-view.ts
  - src/dashboard/spa/live-page/fatigue-model.ts
  - src/dashboard/spa/live-page/ExerciseHeader.tsx
  - src/dashboard/spa/live-page/RestView.tsx
  - src/dashboard/spa/live-page/live-copy.ts
  - src/dashboard/spa/live-page/LivePage.tsx
  - src/dashboard/spa/live-page/model.ts
  - src/dashboard/spa/live-page/DivergingLiveStage.tsx
  - src/dashboard/spa/live-page/stage-variant.ts
lastVerified: 2026-09-28
---

# Read pacing and form

This tour covers the parts of the live page that are about how you move rather than how tired
you are: the tempo target and its light, the range-of-motion light, the rest stage and its pace
footer, and the left and right readout on a two-Voltra rig. For what each signal measures, read
[Technique signals](/concepts/technique-signals) and
[Pacing each rep](/concepts/fatigue-and-pacing#pacing-each-rep); this page does not repeat them.

Every capture here comes from the real MCP tools running against the mock adapter
(`VOLTRA_ADAPTER=mock`), never a real device (`src/docs/capture-shots.ts`).

## 1. The tempo target

A tempo target is four numbers in seconds: lowering, pause at the bottom, lifting, pause at the
top (`src/dashboard/tempo-defaults.ts:21-22`). The dashboard uses the tempo your coach set on the
planned exercise, else the exercise's default, else none
(`src/dashboard/tempo-defaults.ts:72-77`). When one applies, it sits under the exercise name in
the header, beside the prescription (`src/dashboard/spa/live-page/ExerciseHeader.tsx:265-273`).
With none, the header shows no tempo rather than an invented one
(`src/dashboard/spa/live-page/ExerciseHeader.tsx:122`).

<CaptureCallouts
  shot="live-mid-set"
  :callouts='[
    {"quote": "Cable Chest Press 3 × 8–10 @ 140 lbs", "text": "The prescription in the header. A tempo target, when one applies, sits with it."},
    {"quote": "VL 20% VL 30% 0.50 0.49 0.47 0.46", "text": "One bar per rep. With a tempo target, each rep is tinted by how far its lifting time sat from the target lifting time."},
    {"quote": "FATIGUE — RPE Good", "text": "The fatigue card. Its three lights sit under this verdict: velocity loss, form and tempo."}
  ]'
/>

The tint compares each rep with the target (`src/dashboard/spa/panels/fatigue-view.ts:139-148`,
`src/dashboard/spa/panels/fatigue-view.ts:419-422`). The card also shows the set's own tempo
next to the target (`src/dashboard/spa/panels/fatigue-view.ts:447-448`).

## 2. The tempo and form lights

The fatigue card carries three lights under its verdict: velocity loss, form (range of motion)
and tempo (`src/dashboard/spa/live-page/fatigue-model.ts:105-107`). Each light is ok, warn or
alarm.

- The **tempo light** compares your reps with each other, not with the target. A tint far from
  the target does not by itself change this light.
- The **form light** compares each rep's range of motion with the set's own working range. The
  card draws a line at 75% of that range on its range-of-motion chart
  (`src/dashboard/spa/panels/fatigue-view.ts:441-443`).

A form or tempo alarm turns the verdict to form breakdown, even when the bars look fast.
[The fatigue verdict](/concepts/fatigue-and-pacing#the-fatigue-verdict) gives the thresholds.
The [fatigue tour](/guides/dashboard-fatigue) reads the verdict word itself.

## 3. The rest stage and the pace footer

When a set closes, the live page switches to its rest stage.

<CaptureCallouts
  shot="live-rest"
  :callouts='[
    {"quote": "SET VERDICT 5 Reps 140 lbs 12%", "text": "The set you just finished: reps, load and velocity loss."},
    {"quote": "Next · Cable Chest Press · set 2 of 3", "text": "What comes next in the plan, under the rest ring."},
    {"quote": "VOLUME 5 TONNAGE 700 lbs", "text": "The session so far, in the rail on the left."},
    {"quote": "1/8 sets", "text": "Working sets done out of every set the plan holds."}
  ]'
/>

The **rest ring** counts down the rest length for this exercise
(`src/dashboard/spa/live-page/RestView.tsx:208-238`). In this capture that is the plan's own
rest, 90 seconds for Cable Chest Press (`scripts/dashboard-plan-drive.mjs:115-123`). When the
plan sets no rest, the ring counts down a default for the exercise's training goal and says
"Default rest" under it, so a default never reads as your coach's number
(`src/dashboard/spa/live-page/live-copy.ts:29-42`). With no rest length at all, a clock counts
up from the end of the set instead (`src/dashboard/spa/live-page/RestView.tsx:241-249`).
[Rest between sets](/concepts/fatigue-and-pacing#rest-between-sets) explains the defaults.

The **pace footer** sits at the bottom of the rail. It shows two tiles: **Left**, the planned
sets still to do, and **ETA**, the time the plan projects the session to end
(`src/dashboard/spa/live-page/model.ts:808-826`). The same estimate drives the clock and pace
marker at the top of the rail (`src/dashboard/spa/live-page/LivePage.tsx:272-280`). Without an
attached plan there is no footer at all, rather than a guessed finish time
(`src/dashboard/spa/live-page/LivePage.tsx:245-252`). The capture does not pin the ETA, because
it is wall-clock time.

## 4. Left and right

With two Voltras bound to the `left` and `right` [slots](/reference/slot), the live page switches to
its diverging stage on its own: one velocity chart per side
(`src/dashboard/spa/live-page/stage-variant.ts:71`).

<CaptureCallouts
  shot="live-dual-mid-set"
  :callouts='[
    {"quote": "MOCK-VOLTRA-LEFT", "text": "The device bound to the left slot. The right side is labelled the same way."},
    {"quote": "VL 20% VL 30% 0.50 0.49 0.47 0.46 0.44 0.43 VL 20% VL 30% 0.50 0.49 0.47 0.46", "text": "Each side has its own bars and loss lines. Here the left side is six reps in, the right side four."},
    {"quote": "L/R 2% Right leading", "text": "The imbalance: the gap in mean rep speed between the sides, and which side is faster."}
  ]'
/>

The fatigue card stays one card for both sides: its verdict and lights describe you as a whole
(`src/dashboard/spa/live-page/fatigue-model.ts:105-109`). The **L/R** figure is the only
per-side number on the wall (`src/dashboard/spa/live-page/DivergingLiveStage.tsx:89-96`). If the
two units were set up differently, the stage shows "L/R held back" and the reason instead,
because the gap would describe the rig rather than you
(`src/dashboard/spa/live-page/DivergingLiveStage.tsx:80-85`). A side with no device bound reads
"awaiting" plus that side (`src/dashboard/spa/live-page/DivergingLiveStage.tsx:101-110`).
[Left and right](/concepts/technique-signals#left-and-right) covers the measurement, and the
[bilateral guide](/guides/bilateral) covers the setup.

## Next

- [Read the fatigue card](/guides/dashboard-fatigue): the verdict word from Good to Slowing.
- [Live workout tour](/guides/dashboard-tour): the whole live page, stage by stage.
