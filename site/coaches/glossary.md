---
title: Glossary for coaches
description: One-line definitions of the training and tool terms the For coaches pages use, each with a link to where it is used.
diataxis: reference
audience: [coach, lifter]
status: available
sources:
  - src/analytics/rir-velocity.ts
  - src/analytics/optimal-mvt.ts
  - src/dashboard/read-models/muscle-week.ts
  - src/store/mrv-guard.ts
  - src/store/working-sets.ts
  - plugins/voltras-channel/skills/pt-session/SKILL.md
  - README.md
lastVerified: 2026-09-27
---

# Glossary for coaches

Terms in alphabetical order. Each entry gives a one-line definition, then a note on how
voltras-mcp treats it and a link to where it appears.

**Block.** A training block under a program, the same thing as a mesocycle. It holds weeks,
which hold workout templates. Used in [the `plan.*` reference](/reference/plan) and
[Running a planned session](/guides/planned-session).

**e1RM.** Estimated one-rep max: the heaviest single rep a lifter could likely complete,
estimated rather than lifted. A fitted velocity threshold makes an e1RM less wrong, never a
measurement (`src/analytics/optimal-mvt.ts:20`). Used in [the `baselines.*` reference](/reference/baselines).

**MEV, MAV, MRV.** Minimum Effective Volume, Maximum Adaptive Volume and Maximum Recoverable
Volume: weekly working-set landmarks for one muscle group
(`src/dashboard/read-models/muscle-week.ts:40-47`). The dashboard's landmarks are
population defaults, not numbers learned from this lifter (`site/reference/dashboard-api.md:76-78`). Used in
[the dashboard API reference](/reference/dashboard-api) and [the `mrvguard.*` reference](/reference/mrvguard).

**Mesocycle.** See Block.

**Outbox.** A local folder where `session.end` drops each session's result text as a file
when the lifter sets `VMCP_TRUECOACH_OUTBOX=on`. Nothing reads or uploads it (`README.md`,
"The outbox"). Used in [Read a session report](/coaches/read-a-session-report).

**RIR.** Reps in reserve: how many more reps the lifter could have done when the set
stopped. 0 is the last rep of a set taken to failure (`src/analytics/rir-velocity.ts:131`).
The weekly report adds an RIR line for an exercise only when the RIR-estimate baseline gate
has enough history, and nothing converts a velocity-loss percentage straight into RIR. Used
in [Read the weekly report](/coaches/read-the-weekly-report) and
[the `rir_velocity.*` reference](/reference/rir_velocity).

**RPE.** Rating of perceived exertion: the lifter's own score of how hard a set was. A stored
RIR-velocity curve is trusted to state RIR or RPE only when its fit error passes a gate
(`src/analytics/rir-velocity.ts:69-80`). Used in [the `set.*` reference](/reference/set).

**Velocity loss.** How much slower the reps got across a set, as a percentage. Claude
reports it after each set and does not convert it into an RPE or RIR
(`plugins/voltras-channel/skills/pt-session/SKILL.md:131`). Read it as a volume dial, not
as distance from failure. Used in [Read the weekly report](/coaches/read-the-weekly-report)
and [the `metrics.*` reference](/reference/metrics).

**Working set.** A set that counts toward the report. Flagged warm-ups are excluded, then
the sets at the top load are kept (`src/store/working-sets.ts`, `README.md`). Used in
[Read a session report](/coaches/read-a-session-report).

**Write-back.** A separate, experimental tool that posts a session's results into that
day's TrueCoach workout with a local browser. It is gated by TrueCoach's terms of service
(`README.md`, "TrueCoach write-back"). Used in
[Consent and the data loop](/coaches/consent-and-data-loop#truecoach-write-back-experimental-and-gated).
