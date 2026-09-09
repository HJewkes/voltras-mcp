# Changelog

All notable changes to `voltras-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This server is not published to a registry: it runs from this checkout, either as the
`voltras-channel` plugin or through `scripts/voltra-pt`. A version here marks a coherent
set of behaviour, not a package release. The `plugin.json` manifest carries its own
version, which consumers must bump-and-reinstall to pick up launcher changes.

Entries name the pull request that shipped them. Anything not listed did not change.

## [Unreleased]

## [0.5.0] - 2026-09-08

Two waves of work, `#244` through `#310`. The device and recording paths gained real
concurrency and mode safety; analytics grew a family of readouts that refuse to guess;
the plan tools learned Renaissance Periodization's volume and progression rules; and the
dashboard stopped fabricating numbers it did not have.

### Added

**Analytics readouts.** Every one is a readout, never a cue, and every one returns raw
numbers with a `null` verdict when no threshold could be cited.

- `metrics.compute quality.hesitation` — unit-free mid-rep hesitation, reported as
  velocity-sign crossings positioned as a fraction of the rep's own range of motion
  (`#282`).
- `metrics.compute quality.bounce` — turnaround dwell at each end of the rep and the
  eccentric-to-concentric peak ratio (`#285`).
- `metrics.compute quality.rom` — within-set range-of-motion decay and rep-to-rep
  variance, with the cross-session comparison gated on baseline confidence, the drift
  guard, and unit compatibility (`#293`).
- `metrics.compute strength.e1rm` — estimated one-rep max from reps, from a
  load-velocity profile, or both (`#287`).
- `metrics.compute history.trend` — per-exercise series, trend, and plateau detection
  over a weekly-bucketed window (`#291`).
- `metrics.compute session.perturbation` and `session.junk_volume` (`#263`).
- A like-vs-like comparability predicate that decides which two sets may be compared at
  all, and names why when they may not. Consumers pick their comparison partner through
  it and report `noValidComparison` with the nearest candidate's failing reasons rather
  than comparing anyway (`#295`, `#307`, `#310`).

**Planning and coaching.**

- `plan.warmup_ramp`, and `set.start` widened to a `setPurpose` enum
  (`working` / `warmup` / `probe` / `technique`) (`#260`).
- Progression routed by rep range with an explicit gates block, reading the athlete's
  tier signal (`#262`); percent-of-load increments with the fixed step as a floor
  (`#279`); a block-boundary goal-realignment prompt on `plan.complete_workout` and
  `plan.next_workout` (`#281`).
- Tier-aware plan lints on template and exercise creation, a weekly hard-set ceiling,
  and the block/week structural lints (`#264`, `#284`). Writes always succeed; lints
  only annotate.
- A coach tempo override on `plan.exercise_create`, threaded through to the
  prescription (`#290`).
- `profile.get_onboarding_gaps`, injury intake, and a medical-clearance gate that defers
  to a doctor and is interpreted by no other tool (`#283`).
- `truecoach.import_week`, a read-only pull of assigned programming (`#256`);
  `report.session_results` with a coach outbox on `session.end` (`#259`); and the gated
  unattended write-back (`#261`).

**Device and recording.**

- `isometric.measure_hold` — one hold, returns immediately, and emits
  `isometric_phase` pushes (`ready` / `go` / `hold` / `stop`) so a coach can pace the
  assessment. The multi-trial tools now reuse it (`#286`).
- A write lease that carries a monotonic generation, with multi-step device writes
  fenced against a steal mid-call and blocking holders aborted through an
  `AbortSignal` (`#289`, `#306`).
- Exercise setups inferred by clustering range of motion, stamped onto sets and
  baselines, with `exercise.confirm_setup` as the only writer of a human-readable label
  (`#294`).
- Failure anchors harvested from naturally-occurring stall sets (`#252`); sets labelled
  with a lifter so a guest working in never pollutes the owner's data (`#257`).
- Firmware-reported peak force and peak power are persisted onto the set and surfaced by
  `set.get`, `session.get`, and the `set_ended` event. Peak power is recorded as an
  unverified raw value and is deliberately not labelled in watts (`#254`).
- `progression.get_for_exercise` takes an optional `side`, and returns a per-arm
  `sideSplit` summary when the filter is omitted (`#270`).
- A local voice fast-path for weight commands (`#244`) and a rotating stop
  acknowledgement phrase pool (`#268`).

**Dashboard.**

- A lbs/kg display toggle. Every calculation stays in pounds; only readouts convert
  (`#278`, `#296`).
- A session title composed from the attached template and block (`#272`), and a
  live-page isometric walkthrough driven by the phase pushes (`#309`).

**Tooling.**

- A `justfile` and an environment-driven plugin launcher (`#265`), a pre-push
  format-check guard (`#280`), and `docs/vocabulary.md` plus
  `docs/dashboard-drivers.md` (`#274`).
- `whisper-cli` is rebuilt on install, and a loud bench pre-flight runs before a session
  (`#245`).

### Changed

- Velocity is converted to metres per second at the bridge, and stored sets are tagged
  with the unit they were captured in (`#246`). Stored positions are normalised on read,
  so sets captured in different eras can be compared (`#303`); the same normalisation now
  covers the MRV guard's velocity reads (`#305`).
- The velocity-loss watch and the progression hold are gated by movement class. On a
  ballistic pull, peak-velocity loss is not a fatigue signal, so the watch is suppressed
  and says so once; `watch.velocityLoss.force` opts back in (`#288`).
- Guided load refuses to start outside Weight Training and writes nothing on refusal.
  `autoSwitchMode: true` switches, waits for the mode echo, then proceeds; an echo
  timeout fails closed (`#292`).
- `bilateral.cascade` sequences the mode write ahead of the other setters, and
  `set.start` keeps refusing until a reverted mode actually recovers (`#253`).
- Auto-armed sets are upgraded in place rather than rejected, and arming is gated on rep
  eligibility (`#255`); reclaimed idle reps reconcile against an already-published
  summary (`#266`).
- Every slot-scoped channel event carries an emit-time `at` (`#267`).
- The channel plugin starts without a dashboard sidecar for non-PT sessions (`#275`).
- Band, Damper, and Isokinetic sets are labelled by their own setting instead of a
  weight they never had (`#271`).
- Server projectors extracted into pure read-models behind a byte-identical HTTP
  snapshot (`#297`); the SPA's remaining shared state collapsed into the store
  (`#301`, `#304`).

### Fixed

- The recap card, the session-completion list, and the exercise hero view stopped
  fabricating zeros for weights and velocities they did not have (`#258`, `#276`,
  `#302`).
- The fatigue view divided a distance already in metres by 1000, so a 0.45 m range of
  motion displayed as 0.00045. Training modes were also labelled with names that did not
  match what the device was doing, and ten tools shipped with no description at all
  (`#248`).
- The grind signature measured the acceleration ramp at the start of a rep, so every
  normal rep read as a full grind. It now measures the dip after the peak (`#277`).
- Per-exercise tempo overrides were keyed on identifiers the catalog does not use, so
  none of them ever fired (`#269`).
- `npm run build` did not typecheck the single-page app, and the dashboard tests were
  typechecked by no configuration at all. Both are covered now, which exposed nine real
  fixture bugs and one genuine gap in the load-velocity profile input (`#273`).
- A stale mode-revert latch, an ignored inactivity timeout under auto-arm, and a live
  header showing the wrong weight (`#249`).
- The dashboard connection badge is derived from live slots, and the real SPA URL is
  served (`#250`).
- `launcher.test.ts` spawns a real process and flaked under parallel suite load; it now
  runs in its own vitest project after the parallel group (`#308`).

### Notes

- Schema version 17. Migrations are additive.
- Requires `@voltras/workout-analytics` 2.x and `@voltras/node-sdk` 0.13 or later.
- Where a threshold could not be quoted from a cited source, the code reports its raw
  inputs and leaves the verdict `null`. This is deliberate and appears in
  `quality.hesitation`, `quality.bounce`, the percent-of-load increment, and several
  comparability clauses.

## Earlier history

Work before `#244` predates this file and is not reconstructed here. Use
`git log --merges` for it.

This repository carries no git tags, so the headings above are not links to releases.
