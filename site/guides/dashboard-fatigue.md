---
diataxis: tutorial
audience: [lifter, coach]
status: available
sources:
  - src/docs/capture-shots.ts
  - scripts/dashboard-plan-drive.mjs
  - src/dashboard/spa/panels/fatigue-view.ts
  - src/dashboard/spa/live-page/fatigue-state.ts
  - src/state/velocity-loss-intent.ts
  - src/dashboard/spa/planner/SessionSummaryPage.tsx
  - src/dashboard/read-models/session-summary.ts
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Read the fatigue card

This tour reads the fatigue card on the live page twice: once on a fresh set that reads Good,
and once on a set that has slowed past the 20% line. It then reads the verdict back on the
session summary. It shows where to look and what each reading means on screen. For why the
verdict works the way it does, read [Fatigue and pacing](/concepts/fatigue-and-pacing); this
page does not repeat it.

Every capture here comes from the real MCP tools running against the mock adapter
(`VOLTRA_ADAPTER=mock`), with each set's rep speeds pinned so every run draws the same bars
(`src/docs/capture-shots.ts`). No real lifter produced these numbers.

## 1. A fresh set reads Good

Start a set and watch the velocity chart and the fatigue card fill in rep by rep. After five
reps of this set, the slowest rep is only a little under the fastest.

<CaptureCallouts
  shot="live-mid-set"
  :callouts='[
    {"quote": "VL 20% VL 30% 0.50 0.49 0.47 0.46 0.44", "text": "One bar per rep. The two lines mark 20% and 30% velocity loss from the best rep."},
    {"quote": "FATIGUE — RPE Good", "text": "The verdict word. No bar is near either line, so it reads Good."}
  ]'
/>

The card needs two reps before it can compare anything. Until then it shows "warming up"
instead of a verdict (`src/dashboard/spa/panels/fatigue-view.ts:432-435`).

## 2. Why the RPE slot shows a dash

The label **RPE** sits next to the verdict with a dash under it. That is deliberate. The effort
readout (RPE and reps in reserve) is coming soon: the dashboard withholds the number until a
trusted fitted effort profile exists for the lifter (VW-485,
`src/dashboard/spa/panels/fatigue-view.ts:428-431`). Read the dash as "not shown yet", not as
zero. [Effort readout](/coming-soon/effort-readout) says what is missing.

## 3. The same card on a slowing set

This set runs ten reps at the same load. Each rep is a little slower than the one before it.

<CaptureCallouts
  shot="live-slowing"
  :callouts='[
    {"quote": "VL 20% VL 30% 0.50 0.49 0.47 0.46 0.44 0.43 0.41 0.40 0.38 0.37", "text": "Ten reps. The last one is 26% slower than the first, so it sits past the 20% line and short of the 30% line."},
    {"quote": "FATIGUE — RPE Slowing", "text": "The verdict word has changed from Good to Slowing."}
  ]'
/>

Slowing is the verdict's warning step. Velocity loss alone is enough for it here: 26% is past
the 20% warning mark and short of the 30% alarm. [The fatigue verdict](/concepts/fatigue-and-pacing#the-fatigue-verdict)
lists all four words and what triggers each.

This set has not reached its stop line. The driver starts the set with no velocity-loss watch
(`scripts/dashboard-plan-drive.mjs:316`), so the line comes from the planned exercise's
training intent or, failing that, the hypertrophy default. The seeded exercise states no
intent (`scripts/dashboard-plan-drive.mjs:115-126`), so the default applies, and it is 30%
(`src/state/velocity-loss-intent.ts:45-49`, `src/state/velocity-loss-intent.ts:113`,
`src/state/velocity-loss-intent.ts:150-154`). The block's "Hypertrophy" focus does not set it.
At 26% the card is in its approaching band, which starts at two thirds of the stop line
(`src/dashboard/spa/live-page/fatigue-state.ts:29-38`,
`src/state/velocity-loss-intent.ts:133-136`). At 30% it would read stop.
[When the live card says stop](/concepts/fatigue-and-pacing#when-the-live-card-says-stop)
explains the stop line and where its number comes from. Neither the card nor the server's
`velocity_loss_exceeded` event ends the set; [the two stop events are advice](/concepts/fatigue-and-pacing#the-two-stop-events-are-advice).

## 4. The verdict on the session summary

After [`session.end`](/reference/session), open **review** in the nav rail. The summary puts
the same verdict word at the top of each exercise and names the set it read.

This capture comes from a different run than step 3: the planned workout, whose exercise verdict
reads Good. The harness has no summary capture of a slowing session yet.

<CaptureCallouts
  shot="session-summary"
  :callouts='[
    {"quote": "FATIGUE — RPE Good", "text": "The exercise verdict, in the same words the live card uses. RPE is a dash here as well."},
    {"quote": "12% peak-to-last within a set — set #2, the set the verdict above reads.", "text": "The worst velocity loss in any working set of this exercise, and which set the verdict reads."}
  ]'
/>

The summary shows no RPE or RIR for the same reason as the live card
(`src/dashboard/spa/planner/SessionSummaryPage.tsx:201-202`). The verdict and the worst-loss
line read the same set: the working set with the worst loss, the later one on a tie
(`src/dashboard/read-models/session-summary.ts:258-280`,
`src/dashboard/spa/planner/SessionSummaryPage.tsx:218-228`).

## Next

- [Pacing and form](/guides/dashboard-pacing-and-form): the tempo and range-of-motion lights
  under the verdict, and the rest stage.
- [Technique signals](/concepts/technique-signals): what the range-of-motion and tempo lights
  measure.
- [Live workout tour](/guides/dashboard-tour): the whole live page, stage by stage.
