---
diataxis: explanation
audience: [lifter, coach]
status: coming-soon
statusNote: 'The analytics (vbt.rir) and the on-screen component already support an RPE/RIR readout; the wall dashboard withholds the number until a trusted fitted RIR-velocity profile exists for the lifter.'
tracking: VW-448, VW-499, VW-920 (internal tracker)
sources:
  - src/dashboard/spa/panels/fatigue-view.ts
  - src/dashboard/spa/planner/SessionSummaryPage.tsx
  - src/tools/metrics-tools.ts
  - src/tools/rir-velocity-tools.ts
  - src/voice/cue-policy.ts
  - site/public/captures/manifest.json
lastVerified: 2026-10-15
sourced: 2026-09-30
---

# Effort readout (RPE and RIR)

An effort readout is a number for how hard a set was: RPE (rate of perceived exertion) or RIR
(reps in reserve, how many more reps you had left). This page is about that number on the wall
dashboard's live fatigue card and session summary. The rest of the fatigue card works today.

## What works today

**The server can estimate reps in reserve for any recorded set.** Ask `metrics.compute` for the
`vbt.rir` pipeline and it returns an estimate for every rep (`src/tools/metrics-tools.ts:317-322`<!-- anchor: case 'vbt.rir' -->,
`src/tools/metrics-tools.ts:2250-2262`<!-- anchor: interface RepRIREstimate -->). If you have a fitted curve for that lift, the estimate
comes from it. If you do not, it comes from a general model, is marked as such, and is always
rated low confidence (`src/tools/rir-velocity-tools.ts:216-240`<!-- anchor: export function estimateRepRir -->).

**A velocity target for a given RIR needs your own curve.** `rir_velocity.target` returns no
target, with a caveat, until `rir_velocity.fit` has fitted a curve for that lift
(`src/tools/rir-velocity-tools.ts:148-163`<!-- anchor: resolveRirVelocityTarget -->). It never falls back to the general model.

**The verdict words work.** The live card and the session summary show a verdict such as Good,
Slowing, Grinding or Form breaking down. That verdict comes from velocity loss, range of
motion and tempo, not from an effort model (`src/dashboard/spa/panels/fatigue-view.ts:444-447`<!-- anchor: velocity/ROM/tempo -->).

## What is not shown yet

The live card and the session summary both hold the effort number back. The live card is built
with no RPE and no reps in reserve (`src/dashboard/spa/panels/fatigue-view.ts:440-443`<!-- anchor: repsInReserve: null -->), and
the session summary does the same (`src/dashboard/spa/planner/summary/VerdictColumn.tsx`).
On the live card, where the RPE number would go, you see a dash next to the word RPE
(`site/public/captures/manifest.json:85`<!-- anchor: FATIGUE — RPE -->). The summary marks the gap "RIR · Calibrating"
instead (`src/dashboard/spa/planner/summary/SummaryHeader.tsx`).

The dashboard holds the number back on purpose. Reading an effort number straight off velocity
loss is a conversion this project does not allow, so the wall waits for a trusted curve fitted
to you (`src/dashboard/spa/panels/fatigue-view.ts:440-441`<!-- anchor: conversion VW-302 forbids -->).

Each live and finished set in the dashboard snapshot already carries a resolved effort (RIR
and RPE once a fitted profile exists), and the analytics compute it
(`src/dashboard/read-models/snapshot.ts:31-38`<!-- anchor: Nothing in the SPA reads -->). The wall does not read it yet. It never shows a
number here until a trusted curve exists.

No spoken cue says an RPE or RIR number either. The cue rules only speak at the start of a set,
at a target hit, at a velocity-loss stop and at the end of a set
(`src/voice/cue-policy.ts:34-45`<!-- anchor: case 'velocity_loss_exceeded' -->).

## What would change this

The readout needs a trusted curve fitted to you for the lift, which means `rir_velocity.fit`
has to run over enough of your sets first. Until then, a coach can still read `vbt.rir` over
MCP, with its basis and confidence attached. The remaining steps are
VW-448 (the effort work, step E), VW-499 (the writer for the RIR you report after a set) and
VW-920 (the bench run that fits the curve).
