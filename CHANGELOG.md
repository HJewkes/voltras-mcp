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

- The declared diet phase now moves autoregulation thresholds instead of only sitting
  next to them (VW-277). A fat-loss phase WIDENS the performance dip tolerated before a
  load cut or a plateau call, and the widening grows with weeks in phase; a gain phase
  tightens it and surfaces the ahead-of-schedule decision sooner; maintenance and an
  undeclared phase leave every number exactly where it was. The same two-axis table
  (deviation size × trend slope, from RP S12's own 0-10 / 10-20 / 20-40% bands) drives all
  three reads: `plan.suggest_progression` can now hold instead of backing off and reports
  `dietPhaseContext` with a rationale clause in its `reasoning`, `metrics.compute`
  `history.trend` gains `plateau.verdict` (`plateau` / `tolerated` / `none`) beside the
  detector's untouched `isPlateau`, and `session.readiness` gains `zoneVerdict`
  (`as-read` / `tolerated`) beside the zone. The tolerance only ever SOFTENS a verdict:
  a gain phase never manufactures a plateau the detector did not find. `coaching.explain`
  gained `meso.diet_phase_tolerance` with the RP S12 note ids and the caveat that the
  corpus is about calories while this applies the shape to training load.

- `accountability.state` reports the coach protocol's position and the decision it would
  make right now, read-only (VW-286, #373). It answers "why has the coach been quiet" with a
  `reason` rather than a shrug: the state (`planned` / `completed` / `missed` / `ghosting`
  / `realign_needed` / `holding`), how many proactive messages have gone out in the rolling
  7-day window the 2-message ceiling is enforced against, and whether today's Sunday or
  Thursday tick would send or stay silent. The Thursday touch fires only on a missed Monday
  or Tuesday session, a flat or worsening adherence direction from `report.weekly`, or a
  skipped session paired with silence since Sunday — otherwise nothing is sent, because
  silence through the week means the plan is on track. Ghosting spends exactly 2 messages a
  week for 2 weeks and then stops for good; any reply, at any latency, clears it and
  re-arms normal cadence. Nothing sends a message yet: the transport is an interface with an
  in-memory implementation, and the schema gains an `accountability_state` table (v20).

- `metrics.compute` `session.readiness` now labels itself: every response carries
  `basis: "heuristic"` and a `note` saying plainly that no published study validates
  fixed-load warm-up velocity as a same-day readiness marker (VW-269). The probe velocity
  also moves: by default it now reads the heaviest pre-working-load set (the last warm-up
  rung, at or above ~70% of the day's working load) instead of the session's first, lightest
  rep, because the light end of a load-velocity profile is the one shown not to discriminate
  fatigue (Senturk, Kumak & Janicijevic, 2026). Pass `probeLoad: "legacyFirstRep"` for the
  old behaviour. `coaching.explain` gained `live.readiness_interpretation` with the same
  citation. `plan.warmup_ramp`'s description now says why running the heaviest rung matters.

- `VMCP_MOUNT_RATING_LBS` gates the anchor load against the mount's pull-out rating (VW-274).
  No wall/rack mount rating is published for any Beyond Power accessory, and isometric mode
  alone measures up to 400 lb on a single unit — roughly 2x the nominal 200 lb working
  ceiling — while eccentric overload is "configurable up to unlimited". `isometric.measure_hold`,
  `isometric.measure_max` and `isometric.measure_imbalance` now refuse (`INVALID_INPUT`, before
  any hold begins) when 400 lb per unit exceeds a configured rating, and `device.set_eccentric`
  refuses the same way when the true peak (concentric weight + overload) exceeds it. With no
  rating configured, all four report `mountLoadWarning` saying the envelope is UNKNOWN — a
  warning, never a refusal, and never silence.

- `exercise.confirm_setup` now accepts an optional setup card — anchor landmark
  (low/mid/chest/high), rack mount hole, the device's cable-length setting, and resistance
  mode (VW-275). `progression.get_for_exercise` compares the most recent session's card
  against the exercise's reference card (the most recently confirmed one, or a
  digest-seeded landmark default when nothing has been confirmed yet) and reports
  `setupCard: { comparability: 'setup_card_mismatch' | 'setup_card_unverified' | 'comparable', ... }`
  alongside the existing left/right geometry gate — a mount-hole or cable-length change
  between sessions is now visible instead of silently changing what a load comparison
  means.

- Cable geometry now gates every left-vs-right read (VW-272). Before the wall's `L/R`
  callout or `progression.get_for_exercise`'s `sideSplit` compares the two arms, the two
  slots' median cable travel is compared: more than 1.15x apart and the verdict is
  `setup_confounded`, both signatures ship with it, and the imbalance is withheld with the
  reason on screen rather than silently. A cable's resistance moment arm moves with its
  anchor, so the same weight at a different anchor height is a different joint torque
  (Keogh, Lake & Swinton 2013) — two units set up differently manufacture an imbalance the
  athlete does not have. `setup_unverified` means a side recorded no travel, so the check
  never ran; it withholds nothing.

- `isometric.measure_imbalance` now runs the same cable-geometry gate (VW-284/VW-272)
  before reporting its asymmetry verdict. Each side's CONFIRMED `exercise_setups` signature
  for the exercise active on that slot is compared; `setupComparability` reports the
  result. On `setup_confounded`, `setupSignatures` and `setupReason` ship with the result
  and `imbalance.real`/`imbalance.direction` come back `null` — the per-side peak forces
  still report, since those are facts about one side each, but reading the gap between
  them as an imbalance is what gets withheld. `setup_unverified` (one or both sides never
  had a confirmed setup) reports the verdict unchanged. An isometric hold has no velocity
  fallback the live wall's callout has: a hold's peak force at a given cable angle is
  determined entirely by anchor position (Keogh, Lake & Swinton 2013).

- `scripts/dashboard-replay-drive.mjs` (VW-256) — the fifth rung of the dashboard driver
  ladder: replays a flight-recorder capture (`VMCP_RECORD_SESSION=1`) through the real
  MCP pipeline and dashboard, off-hardware, using the SDK's `ReplayBLEAdapter` and
  `loadCaptureFrames`. See `docs/dashboard-drivers.md`.

- `isometric.measure_max`, `measure_hold` and `measure_imbalance` now headline peak force,
  not plateau force (VW-271) — peak force is the metric the reliability literature actually
  validated (unilateral IMTP peak force ICC 0.89-0.97, CV 3.4-4.9%). RFD and impulse-to-peak
  move to a per-trial `diagnostic` block, labelled diagnostic-only: early-phase force CV runs
  5.5-23.3% and Weakley et al. (2024) call RFD "not recommended" for monitoring change.
  `measure_max` and `measure_imbalance` now also persist and read back a per-athlete
  `peakForceBaseline` (mean, SEM and CV over past test occasions) and flag
  `changeFromBaseline` only when a result clears the adjusted SEM (SEM × √2) — the same
  noise-floor discipline VW-270 applied to asymmetry, applied here to a single limb's own
  trend over time.

- `report.weekly` (w3-91) — a coach-readable weekly summary, in markdown or JSON, over a
  date range (default: the last 7 days). Sessions completed, a rolling 28-day
  completed-session count, adherence against the active program with a trend vs. the
  previous range, per-session results plus a gated RIR line, `plan.suggest_progression`
  suggestions, flags (force-implied weight mismatches, inactivity-timeout closes,
  velocity-loss holds), and a check-in section read from `self_reports`.

- The documentation site renders this changelog at `/changelog` (#348). The page was a
  stub; it now includes this file verbatim, so there is one copy to read and one to write.

- Two narrated screen recordings on the documentation site (w5-08): a working set landing
  on the wall dashboard with its plan prescription attached, on the planned-session guide,
  and two Voltras diverging through a set and falling through to rest, on the bilateral
  guide. Both are produced headlessly from the mock adapter by `npm run docs:captures` —
  the same harness that makes the screenshots — and both pages say the narration is
  synthetic and link the script it was spoken from.

- Every estimated 1RM now arrives with an error band and a `fitFor: "trend"` marker
  (VW-267). `metrics.compute` `strength.e1rm` attaches the pooled standard error (9.8% of
  1RM, sized to the estimate) and the 3.7% systematic overestimate — reported, never
  subtracted — to the two velocity-derived methods; the Epley rep method gets the marker
  and a note saying why no figure applies to it. `history.trend` with `metric: e1rm` carries
  the same band, and is the path an e1RM is actually fit for. `plan.suggest_progression`
  says outright that no gate of its own reads an e1RM: a one-session jump inside the band is
  noise and moves no load.

- `coaching.explain` topic `meso.asymmetry_interpretation` (VW-270) — why a left/right
  difference has to clear the athlete's own noise before it means anything, why no universal
  cutoff survives the evidence, and why a consistent direction over time may warrant
  attention while a fluctuating one does not.

- `coaching.explain` topic `meso.e1rm_interpretation` (VW-267) — how to talk about an e1RM
  that moved, with the reliability figures and their citations. The first topic sourced
  from primary literature rather than the mined RP corpus.

- `profile.set_diet_phase` — the first writer of `diet_phases`, which had DDL and a
  comparability clause but nothing to fill it (VW-149 / VW-150). It records the OBSERVED
  phase (fat-loss / gain / maintenance) as a time range, closes the previous range at the
  new start, and accepts a past `startedAt` to correct history. Sessions are stamped with
  the covering phase at write; the table stays the source of truth on read. Distinct from
  a plan week's PRESCRIBED `phase_type`, which nothing here touches.

- The accountability coach's five proactive messages now have fixed wording: the Sunday
  anchor, the miss-recovery prompt, the two ghost nudges and the realign opener (VW-287).
  The Sunday anchor shows last week's planned-versus-recorded numbers and the trend
  direction back instead of asking how the week went, names each planned day's fallback
  slot, and says once that silence through the week means the plan is on track. A missed
  session gets one reduced-scope re-entry on a named day, taken from `plan.next_workout`;
  the same missed day inside a declared hold gets no miss framing at all. Progress is a
  rolling 28-day session count, never a streak, and a frequency change is offered as
  re-architecting within the same number of days rather than fewer of them. No tool sends
  any of this yet: the state machine that decides when is separate work.

### Changed

- Requires `@titan-design/react-ui` ^0.13.0 (#359). No SPA source change: the dashboard already
  passed no `header` prop to `LiveFatiguePanel`, does not use `ExerciseHeaderLite`,
  `useTheme`, `Pill`, or the `Shell` family, so none of this release's removals or shape
  changes land on the wall. The live-page screenshot at rest and mid-set is unchanged.

- A detected asymmetry no longer reads as a reason to prescribe single-limb work anywhere in
  the server (VW-273). `coaching.explain` `meso.asymmetry_interpretation` says so outright and
  gives the evidence: unilateral training beats bilateral for unilateral jump and loses to it
  for bilateral strength, with everything else non-significant, so unilateral work is
  goal-specific rather than corrective, and the stated answer to a difference is consistent
  strength training over time. `plan.suggest_progression` says the same in its own
  description, and neither it nor any `progression.*` path reads a left/right difference.
  The bilateral guide carries both statements.

- The inferred working weight from an isometric hold is now labelled in the RESULT, not only
  in the tool description (VW-273). `isometric.measure_max` and `isometric.measure_imbalance`
  both return `inferredWorkingWeightBasis`, which says it is a heuristic rather than a
  validated conversion and carries the joint-angle caveat: an isometric squat predicted the
  full squat at r 0.864 at 90 degrees of knee flexion but only r 0.597 at 120 degrees. A
  description is read once; the number is read every time.

- `isometric.measure_imbalance` no longer calls an asymmetry noteworthy at 10% or meaningful
  at 15% (VW-270). Both constants are gone. It reports `asymmetryPct` with the `equation` it
  came from, each limb's own trial-to-trial CV, and marks the difference `real` only when it
  exceeds that CV — a 10% gap between limbs whose own trials vary by 12% is the measurement
  talking, and the old constants could not tell the two apart. A new `directionHistory` says
  whether the SAME limb dominated across recent tests (`consistent-left` /
  `consistent-right` / `fluctuating`, or `insufficient-history` under three tests), because
  direction over time is what a series of these can support and one magnitude is not. No
  stored row changed: every verdict is still recomputed from the persisted per-trial forces.

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

- The velocity-loss stop threshold is keyed to the training goal instead of being whatever
  number the caller typed (VW-266). A `velocity_loss_exceeded` trigger now takes an
  `intent` — `strength` 20%, `hypertrophy` 30%, `power` 10% — or takes it from the planned
  exercise's new `trainingIntent`, and `coaching.explain {topic:
"live.velocity_loss_threshold"}` returns the published bands with their citations. An
  explicit `pct` still wins and behaves exactly as before; a trigger with no threshold from
  any of the three is refused rather than registering a watch that can never fire. The
  fired event says which source supplied its number, and a goal-derived one carries the
  caveat that velocity loss is a volume dial, not a reps-in-reserve estimate.

### Fixed

- A set run with the eccentric loaded above the concentric no longer gets a velocity-loss
  stop cue about a rep early (VW-268, #354). Rep 1 of such a set is the only rep with no
  overloaded eccentric before it, so it was the fastest rep in the set for mechanical
  reasons and became the baseline the rest were judged against. The stop now measures from
  rep 3, and the `velocity_loss_exceeded` event says which reps it left out and why.

- The wall's "sets done" tally and the session-completion page's "N / target sets" count
  now agree with `plan.suggest_progression` on which sets are working (VW-283). Both
  previously counted an unflagged heavy-primer set below the session's top load as a
  working set; `plan.suggest_progression` already excluded it. All three now share the
  one predicate.

- A database last written by an older build no longer gets refused outright if its
  version happens to fall on a number the schema check forgot to list by hand (VW-288).
  The check now accepts any version up through the current one and migrates it forward,
  instead of a hand-maintained list that had to be remembered on every bump.

- Two CI test flakes under runner load, neither an assertion failure, both a 5 s default
  timeout hit before real work finished (VW-285). The replay-driver integration test now
  carries an explicit 20 s timeout for its inherent ~550 ms real-time playback wait, and
  the v6→v7 migration suite — whose `sets` rebuild is real, un-batched disk I/O — now
  carries an explicit 20 s suite default instead of relying on vitest's 5 s one.

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
