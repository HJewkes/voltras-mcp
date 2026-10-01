---
title: Calibration and trust
description: Which numbers the server measures and which it derives, which ones are checked against anything, and why a trend is worth more than a single reading.
diataxis: explanation
audience: [lifter, coach]
status: available
sources:
  - src/state/event-bridge.ts
  - src/store/velocity-units.ts
  - src/tools/set-tools.ts
  - src/tools/e1rm-band.ts
  - src/tools/metrics-tools.ts
  - src/tools/isometric-tools.ts
  - src/tools/baseline-tools.ts
  - src/tools/drift-guard-tools.ts
  - src/store/exercise-baselines.ts
  - src/dashboard/read-models/muscle-week.ts
  - src/store/mrv-guard.ts
  - src/dashboard/spa/body/BodyView.tsx
  - src/analytics/rir-velocity.ts
  - site/guides/isometric.md
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Calibration and trust

Every number this server shows has a source. Some come straight off the device. Others are
worked out from those readings. This page explains which is which, and how far to trust each kind.

## Measured and derived

The device streams readings while you move. The server groups them into reps as each lift-and-return
cycle ends (`src/state/event-bridge.ts:24-27`). Each reading carries the cable's position, speed and
force. Range of motion is worked out from the positions (`src/state/event-bridge.ts:652-667`,
`src/state/event-bridge.ts:824-827`). Per-rep
speed and range of motion are the closest thing to a measurement the server has.

Almost everything else is derived. Velocity loss, the fatigue verdict, estimated 1RM (e1RM),
readiness and reps in reserve are all calculations over recorded reps
([`metrics.compute`](/reference/metrics): `src/tools/metrics-tools.ts:278-321` for velocity loss,
the fatigue verdict and RIR; `src/tools/metrics-tools.ts:514-515` for e1RM;
`src/tools/metrics-tools.ts:407` for readiness). A derived number can be no
better than its inputs, and it adds its own error on top.

Some derived numbers say how rough they are. Every e1RM travels with an error band. That band
is marked as fit for tracking a trend, never as the number that sets today's load
(`src/tools/e1rm-band.ts:1-16`, `src/tools/e1rm-band.ts:57`). The readiness reading always carries a
`heuristic` basis, because no published study validates the signal it reads
(`src/tools/metrics-tools.ts:66-73`).

## Why trends beat absolutes

A consistent error cancels out when you compare two readings taken the same way. It does not
cancel when you read one number on its own.

The server's own history shows this. Sets recorded before a units fix stored velocity on a
different scale. Absolute speeds from those sets were wrong, but velocity loss, estimates of reps in reserve
([RIR](/concepts/velocity-and-effort#velocity-and-effort)) and fatigue verdicts were not, because they are ratios (`src/store/velocity-units.ts:10-13`).

So when a figure is uncertain, compare it with yourself. This week against last month, or left
side against right side, is a more reliable read than any single value. The
[isometric guide](/guides/isometric#the-calibration-caveat) makes the same point about force.

## Velocity units are tagged

Each recorded set carries a tag that names the unit its velocities were stored in. Every new set is
tagged as metres per second (`src/tools/set-tools.ts:1624`). Older sets keep their original scale on
disk, and the server rescales them when it reads them (`src/store/velocity-units.ts:1-8`,
`src/store/velocity-units.ts:48-51`). This keeps the evidence of which scale a row came from, and
lets old and new sets be compared (VW-160).

## Isometric force

The isometric tools report pull force in pounds. That reads like a settled physical measurement.
Its plateau detection and inferred working weight have not been re-checked on hardware since the
underlying force scale last changed (`src/tools/isometric-tools.ts:1463-1468`). The [isometric guide's calibration
caveat](/guides/isometric#the-calibration-caveat) explains what that means for peak and plateau
figures.

## Volume landmarks are not yours

The body page counts your weekly working sets per muscle. It compares each count with three volume
landmarks (`src/dashboard/read-models/muscle-week.ts:1-5`, `src/dashboard/read-models/muscle-week.ts:40-48`):

- **MEV**, minimum effective volume.
- **MAV**, maximum adaptive volume.
- **MRV**, maximum recoverable volume: the point past which added volume produces only fatigue
  (`src/store/mrv-guard.ts:6-7`).

The landmarks the server uses are population defaults. They are copied from a shared design
library's default table, not learned from your training
(`src/dashboard/read-models/muscle-week.ts:17-21`, `src/dashboard/read-models/muscle-week.ts:50-61`).
Their basis is fixed as `population-default`, and the page prints that basis under the panel
(`src/dashboard/read-models/muscle-week.ts:147`, `src/dashboard/spa/body/BodyView.tsx:257-260`).

Your own landmarks may sit well away from the defaults. Finding them from your set history is
tracked as VW-146. Until then, `history.weekly_volume` in [`metrics.compute`](/reference/metrics)
leaves its verdict empty rather than judge your volume against someone else's numbers
(`src/dashboard/read-models/muscle-week.ts:19-21`).

## Baselines and drift

The server keeps a confidence state for each exercise you train. It moves from COLD through
SHAPE_ONLY and PROVISIONAL to CALIBRATED as evidence builds up, and drops to STALE after a long gap
(`src/store/exercise-baselines.ts:263-280`). At SHAPE_ONLY, relative signals such as velocity loss
are honest, but anything phrased in reps to failure is not
(`src/store/exercise-baselines.ts:269-271`).

[`baselines.get`](/reference/baselines) reads that state. It is a diagnostic read, not a value
lookup. Its own description says to treat numbers from a baseline below CALIBRATED as provisional
(`src/tools/baseline-tools.ts:65-73`).

[`driftguard.check`](/reference/driftguard) is also diagnostic. It shows whether two sessions of an
exercise were comparable, for example after a change in range of motion, tempo or setup. It gives
the same verdict the internal checks use (`src/tools/drift-guard-tools.ts:30-34`).

Neither tool tells you what to do. They tell you how much the server knows
(`src/tools/drift-guard-tools.ts:35-36`, `src/tools/baseline-tools.ts:67-68`).

## Effort numbers

The strictest trust rules in the server apply to reps in reserve. A fitted effort curve counts as
trusted only when its error is 1.5 reps or less (`src/analytics/rir-velocity.ts:62-80`).
[Velocity and effort](/concepts/velocity-and-effort) explains that rule and where the dashboard
withholds effort numbers today.
