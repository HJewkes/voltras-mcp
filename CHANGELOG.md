# Changelog

All notable changes to `voltras-mcp` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This server is not published to a registry: it runs from this checkout, either as the
`voltras-channel` plugin or through `scripts/voltra-pt`. A version here marks a coherent
set of behaviour, not a package release. The `plugin.json` manifest carries its own
version, which consumers must bump-and-reinstall to pick up launcher changes.

Entries name the pull request that shipped them. Anything not listed did not change.

## How to write an entry

Entries are hand-written. There is no generator, no changeset tooling and no release
workflow: this file is the record a reader trusts, so a human writes it.

- Write what a **user** can now do, now sees, or no longer has to work around. Not which
  file changed and not how it was implemented. "The rest timer now announces the last ten
  seconds" is an entry; "refactored `timer-tools.ts`" is not.
- Put it under `## [Unreleased]`, grouped **Added / Changed / Fixed / Removed**. Add only
  the groups the release actually has.
- Name the pull request that shipped it, as `(#123)`, or the ticket and the PR when both
  exist.
- **A change with no user-visible effect gets no entry, and that is fine.** Refactors,
  test-only changes and internal renames belong in `git log`, not here. Padding this file
  to prove work happened makes it useless for the thing it is for.
- On release, rename `[Unreleased]` to the new version with its date, bump
  `package.json`, and open a fresh empty `[Unreleased]`.

`npm run changelog:check` enforces the mechanical half of this in CI: the version in
`package.json` has a section, sections run newest first, and no released section is empty.
An empty `[Unreleased]` is the normal state after a release and never fails. Whether an
entry is written from the user's point of view is a review question, not a check.

## [Unreleased]

### Added

- `report.weekly` (w3-91) — a coach-readable weekly summary, in markdown or JSON, over a
  date range (default: the last 7 days). Sessions completed, a rolling 28-day
  completed-session count, adherence against the active program with a trend vs. the
  previous range, per-session results plus a gated RIR line, `plan.suggest_progression`
  suggestions, flags (force-implied weight mismatches, inactivity-timeout closes,
  velocity-loss holds), and a check-in section read from `self_reports`.

- The documentation site renders this changelog at `/changelog` (#348). The page was a
  stub; it now includes this file verbatim, so there is one copy to read and one to write.

- Every estimated 1RM now arrives with an error band and a `fitFor: "trend"` marker
  (VW-267). `metrics.compute` `strength.e1rm` attaches the pooled standard error (9.8% of
  1RM, sized to the estimate) and the 3.7% systematic overestimate — reported, never
  subtracted — to the two velocity-derived methods; the Epley rep method gets the marker
  and a note saying why no figure applies to it. `history.trend` with `metric: e1rm` carries
  the same band, and is the path an e1RM is actually fit for. `plan.suggest_progression`
  says outright that no gate of its own reads an e1RM: a one-session jump inside the band is
  noise and moves no load.

- `coaching.explain` topic `meso.e1rm_interpretation` (VW-267) — how to talk about an e1RM
  that moved, with the reliability figures and their citations. The first topic sourced
  from primary literature rather than the mined RP corpus.

- `profile.set_diet_phase` — the first writer of `diet_phases`, which had DDL and a
  comparability clause but nothing to fill it (VW-149 / VW-150). It records the OBSERVED
  phase (fat-loss / gain / maintenance) as a time range, closes the previous range at the
  new start, and accepts a past `startedAt` to correct history. Sessions are stamped with
  the covering phase at write; the table stays the source of truth on read. Distinct from
  a plan week's PRESCRIBED `phase_type`, which nothing here touches.

### Changed

- Requires `@titan-design/react-ui` ^0.13.0 (#359). No SPA source change: the dashboard already
  passed no `header` prop to `LiveFatiguePanel`, does not use `ExerciseHeaderLite`,
  `useTheme`, `Pill`, or the `Shell` family, so none of this release's removals or shape
  changes land on the wall. The live-page screenshot at rest and mid-set is unchanged.
- Requires `@voltras/workout-analytics` 3.x (#353). No behavior change: `history.trend`
  already discards `analyzeTrend`'s categorical verdict and reports its own explicit
  `null` direction (VW-230), and this server does not call `findOutlierReps`,
  `updateBaselineWithPoint`, or reference `FatigueSchemes.outlier` — the surfaces 3.0.0
  changed or removed.
- The rep-corrections gate is split in two (VMCP-02.65). `VMCP_REP_UNRACK_DROP` (default `off`)
  gates the un-rack drop, which is unchanged and still dark behind VW-16; `VMCP_REP_ECC_TRUNCATE`
  (default **`on`**) gates the final-eccentric idle-tail truncation, which is now applied by
  default. `VMCP_REP_CORRECTIONS` still sets both halves when it is set, so an existing `on` or an
  explicit `off` behaves exactly as before.

  What moves: on the FINAL rep of a set only, and only in the persisted set and the `set_ended`
  payload, `tempo_ratio` and eccentric mean velocity now exclude the parked-cable samples that
  trail the last real movement. On the observed case that motivated this, last-rep `tempo_ratio`
  read 35.1 where the movement it describes is nearer 1-3, and eccentric mean velocity read
  ~0.002 m/s. Persisted values for newly recorded sets will therefore differ from historical ones
  for that rep. Existing stored sets are NOT rewritten. No rep is added or removed, no raw sample
  is altered, and the live per-rep `rep_finalized` event still carries the raw analytics rep.

- The comparability predicate's training-phase clause is live: it reads the observed phase
  of each set's session instead of being unchecked on every pair. A pair with no phase on
  either side still passes with a note, so pre-existing history compares as before.
- `metrics.compute history.trend` reports the observed phase covering the plateau window
  in `plateau.phase` instead of a hardcoded `'unknown'`, which it still returns when no
  single declared phase covers the window. The plateau verdict itself is unchanged: a
  fat-loss phase looks like a plateau (B34), and B34 states no correction, so none is
  applied — the phase is there for a reader to discount by hand.

### Fixed

- A set run with the eccentric loaded above the concentric no longer gets a velocity-loss
  stop cue about a rep early (VW-268, #354). Rep 1 of such a set is the only rep with no
  overloaded eccentric before it, so it was the fastest rep in the set for mechanical
  reasons and became the baseline the rest were judged against. The stop now measures from
  rep 3, and the `velocity_loss_exceeded` event says which reps it left out and why.

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
