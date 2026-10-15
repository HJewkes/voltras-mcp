---
diataxis: overview
audience: [lifter, coach, developer]
status: available
sources:
  - src/tools/mock-tools.ts
  - tools/truecoach-submit/src/selectors.js
  - src/tools/session-tools.ts
  - src/tools/metrics-tools.ts
  - src/config.ts
  - src/dashboard/spa/panels/exercise-hero-view.ts
  - docs/architecture/future-convergence-deep-dive.md
  - src/dashboard/spa/days/days-client.ts
  - src/dashboard/read-models/banners.ts
lastVerified: 2026-10-15
sourced: 2026-09-30
---

# Roadmap

The [guides](/guides/) and [reference](/reference/) describe what this server does today.
This page is the opposite list: things that are present in the code — a registered tool, an
environment variable, a documented direction — but don't yet do, or fully do, what a reader
would reasonably expect from their name. Nothing here is a commitment or a date; several
items are directions under consideration, not decisions.

Dashboard screens that are built but not yet usable end to end have their own pages under
[Coming soon](/coming-soon/).

## Registered but does nothing

- **`mock.configure` and `mock.inject_error`.** In mock mode, both tools are registered and
  accept input, so a caller might expect them to reconfigure the mock device or trigger a
  simulated fault. Calling either always returns an error saying the capability doesn't exist
  yet, regardless of input — the mock adapter has no runtime configure or error-injection API
  to call into (`src/tools/mock-tools.ts:84-120`).

## Off by default and unfinished

- **`VMCP_REP_SOURCE=firmware`.** Switches which pipeline reps are read from. It exists in
  code but hasn't been validated against hardware, so the default stays `analytics` until that
  happens (`src/config.ts:269`).
- **`VMCP_REP_UNRACK_DROP=on`.** Drops the un-rack artifact rep when a set closes. It hasn't
  been checked across every movement type; turning it on for an unvalidated movement can drop a
  valid rep, so it defaults off (`src/config.ts:284-288`). The older `VMCP_REP_CORRECTIONS`
  switch moves it and its companion correction together when set.
- **`VMCP_CUE_DELIVERY=on`.** Speaks the automatic cues through the newer cue-delivery layer
  instead of the original rule. Off by default ([How coaching works](/concepts/how-coaching-works#automatic-spoken-cues),
  `src/config.ts`).
- **`VOLTRAS_EFFORT_CUE=on`.** Lets an effort rule pick the one ending cue for a set. Off until
  it has been tested on the device (`src/config.ts`).

## Served, but on no page yet

The dashboard server answers these reads, but no page draws them, so you only see them by
calling the route ([Dashboard API](/reference/dashboard-api)):

- **`/api/session-review`**: the past days still waiting for a training or test mark. A
  client and a model for a day-review page exist, but no route opens one
  (`src/dashboard/spa/days/days-client.ts`, `src/dashboard/spa/routing.ts`).
- **`/api/banners`**: the one banner the wall should show. Only the "planned week with nothing
  recorded" banner has a producer (`src/dashboard/read-models/banners.ts`).

## Known to be uncalibrated or unverified

- **Isometric hold force.** `isometric.measure_hold`, `measure_max`, and `measure_imbalance`
  report peak and plateau force in pounds, which reads as a settled physical measurement. Their
  plateau detection and inferred working weight haven't been re-checked on hardware since the
  device's raw force scale last changed (`src/tools/isometric-tools.ts:1464-1469`). See [the calibration caveat](/guides/isometric#the-calibration-caveat)
  before treating an absolute number as calibrated. Trends within or across a session hold up
  better than any single reading.
- **The TrueCoach results-submission control.** Ships in code, but nobody has exercised the
  actual submit click — the selector is marked unverified
  (`tools/truecoach-submit/src/selectors.js:31`).

## Designed, not built

- **Setting training mode at session start.** A reader might expect `session.start` to take a
  mode as a parameter. It doesn't — the session records whatever mode was already active from
  an earlier `device.set_mode` call (`src/tools/session-tools.ts:399-406`).
- **Weekly volume verdicts.** `history.weekly_volume` (see [the metrics reference](/reference/metrics))
  reports real weekly totals and a muscle-group breakdown, so a reader might expect it to also
  say whether that volume is on target. The verdict field is always empty: classifying it needs
  per-athlete volume targets, and this tool reads none. `goal.propose_targets` derives a
  weekly-set dose for a muscle priority, but this tool does not read it
  (`src/tools/metrics-tools.ts:964-973`).
- **Mean velocity on the exercise hero's set row.** The per-rep velocity bars read each rep's
  mean velocity, but the hero's set row still reads peak velocity, so it reads higher than the
  rest recap. The shared analytics library already publishes the mean version; switching over
  is an open decision, not something blocked on a missing dependency
  (`src/dashboard/spa/panels/exercise-hero-view.ts:66-70`).
- **Sharing more logic between the wall dashboard and a mobile app.** The two connect to the
  device in different ways today and don't share view logic. A direction for unifying more of
  that is documented; it isn't scheduled
  (`docs/architecture/future-convergence-deep-dive.md`).

---

This page is a snapshot, not a commitment, and it can go stale. The issue tracker is the
authoritative, current list of unfinished work — not this page.
