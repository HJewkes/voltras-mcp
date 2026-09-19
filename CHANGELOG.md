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

### Fixed

- The wall's type finally matches its designs. The goal hero ("+16 lb beyond goal") drew at
  16 px regular instead of 40 px bold, and the same fault flattened the bold set facts, the
  top bar lockup, breadcrumb, idle pill and clock, the nav labels, and the top bar dividers
  (0 px tall, now 16). Cause: titan's published build dropped every size, weight and leading
  override a component passed to its text; fixed upstream in `@titan-design/react-ui` 0.18.1
  and picked up here. Nothing was redesigned, the intended styles now apply (VW-420).

## [Unreleased]

### Added

- A set in progress or a rest countdown now stays in view on every dashboard page, not just
  the live one. A one-row strip above the page shows the exercise, set n of m, the rep count,
  the last rep's velocity with one bar per rep, and the rest seconds left; pressing it returns
  to the live page. It appears only for a planned exercise. Its rest counts down the same length
  as the live page (the plan's, else the goal default), and it turns red at the same stop
  (VW-429, #448; VW-440, VW-441).
- Once a goal accepted as the starting ramp has calibrated, the coach offers a target based on
  the lifter's own lifts, once. `goal.propose_targets` and `goal.weekly_review` return it in
  `recalibrationOffers`. It keeps the ramp's block (same start, end and weeks), and only the
  numbers change. Accepting it (`goal.accept_target` on the offer) retires the ramp and never
  edits it. Declining it (`goal.retire` on the offer) keeps the ramp and is not asked again
  that block. An offer whose lift stops being calibrated, or whose ramp is retired, is
  withdrawn. Under the card, the goals page reads "Calibrated. Your goal is still the starting
  ramp; a target based on your lifts is ready." while the offer stands, and nothing after a
  decline (VW-444).
- A goal accepted before its lift is calibrated now says so. Under a calibrating goal card
  the goals page reads "Starting ramp, not yet based on your lifts." followed by what
  calibration still waits on: "1 more comparable session to calibrate.", or a set taken near
  failure, or more working sets of the lift, with no invented count when the baseline is what
  blocks. `/api/goal-progress` carries the same facts as a structured `calibration` field
  (sessions still needed, which gate blocks, the baseline state, and the accepted target's
  basis). `goal.propose_targets` and `goal.accept_target` add a `startingRamp` notice to a
  cold lift target telling the coach to re-propose a data-based target once calibration ends.
  Nothing stored changes, and nothing is refused (VW-444).
- The goal coach now says when a goal is met. A target reads `goal_met` once a matched set
  lifts the committed number and `beyond_goal` once one passes it, and keeps that verdict for
  the rest of the block rather than slipping back to a pace word after a lighter week. Each
  target also carries its block-end milestone (the committed set, the current week, the latest
  reading, and whether it is still open, hit, or missed at the block boundary) and a per-week
  verdict against that week's band, so the goal card needs no maths of its own (VW-400).
  `dashboard:preview -- goals --state hit_exact|beyond_goal` now lands on those two verdicts.
- `goal.accept_target` takes `anchorLoad` for a `reps_at_load` target, so the goal reads as a
  whole set ("12 reps at 185 lb") rather than a bare rep count. It is fixed with the rest of
  the target, and any other metric refuses it (VW-399).

- `npm run dashboard:preview -- goals` (also `body` and `plan`) opens one wall dashboard
  page in a browser with no Voltra, no PT session and no risk to your training history: it
  seeds a scratch store, boots a mock-adapter server over it on a free port, prints the URL
  and holds it open until Ctrl-C, deleting the store on the way out (VW-416). The goals page
  takes `--state calibrating|on_track|behind|ahead|hit_exact|beyond_goal`, which seeds the
  readings that land the goal coach in that state — the statuses a driven mock run cannot
  reach, because a band with no established baseline is always still calibrating (#440).
- The dashboard has a fourth page: `#/body`, reached from the Body item on the nav rail,
  which has been in the rail's source since the shell landed and filtered out until now
  (VW-338). It shows the week at a glance on two body figures — front and back, each muscle
  filled by where its weekly working sets sit against the population MEV/MAV/MRV landmarks —
  with the lifts the current training week still owes, the personal records the strength read
  found, the week's set and muscle counts, and a strip of all fifteen muscles with sets
  against target. The landmarks are labelled as population defaults on the page, because they
  are: nothing here is fitted to you. The page shows no live telemetry at all; a set running
  while it is open cues the Live rail item instead.
- The published docs screenshots now include the `#/goals` wall page: a declared priority,
  the accepted committed/stretch band, its trajectory chart, and the PR star from a heavier
  set passing last week's reading (VW-389).
- The `#/goals` page now stacks to one column on a phone-width screen instead of squeezing
  its four-card grid and 1200px-wide trajectory chart into a viewport neither fits (VW-356).

### Changed

- A slow-loss recomposition's bodyweight goal is now a band instead of one line: holding
  the start weight is the committed edge and -0.5 %/wk is the stretch (VW-468). The Sunday
  `goal.weekly_review` judges against the same band the goals page draws; before, it used
  the cut's -0.5 to -1 %/wk band. A flat week reads on track rather than as noise to wait
  out, a gaining week reads behind, and a loss inside the band draws no correction. The
  hold is judged in the block's last week, so an early flat weigh-in no longer marks the
  goal met for the whole block. Accepted targets keep the numbers they were derived with
  until the next block re-derives them (#458).
- Every other session count now counts training days too, by the same rule as the
  sessions goal: a day with a dozen exercises logged as separate sessions counts once
  (VW-462, #457).
  - `report.weekly` reads "Training days: N" and "Last 28 days: N training days". JSON
    fields renamed: `header.sessionsCompleted` to `header.trainingDaysCompleted`, and
    `header.rolling28DayCompletedSessions` to `header.rolling28DayTrainingDays`.
  - The coach's Sunday and realign messages read "Rolling 28-day training days: N."
    `accountability.preview` renames `inputsUsed.rolling28DayCompletedSessions` to
    `inputsUsed.rolling28DayTrainingDays`, and a preview with `at` now counts as of `at`
    instead of the current time.
  - `session.checkin` withholds soreness, joint and motivation until the lifter has
    trained on an earlier day, so every session of a first training day withholds them.
    Before, the second exercise of that first day already asked.
  - A lifter back from a 3+ month gap stays in the return mesocycle for 12 training days,
    not 12 sessions, so one long first day back no longer ends it.
- The goals page's whole-body goals now carry what the page needs to explain them. Each
  goal says which way better points (`up`, `down` or `hold`), so a maintenance corridor no
  longer draws as a gain and a slow-loss recomposition draws as a loss. A bodyweight goal
  carries the diet phase in force now and its weekly rate against the phase's rate. The rate
  is computed by the same code `goal.weekly_review` runs, so the two cannot disagree. A
  sessions goal carries the count due by now, the days trained in the window, and how many of
  them leave the window in the next week. Week 1 of a cut or gain band now runs from the start
  weight to the end of the first week's stretch step, so a first weigh-in at the start weight
  reads inside it (VW-459, #456).
- An accepted bodyweight goal with no recent weigh-in stays on the goals page instead of
  disappearing, and a goal the page cannot draw is logged as a warning (VW-459, #456).
- `goal.declare_priorities` refuses a second whole-body priority for the same ref (for example
  `bodyweight` and `Bodyweight`) with `GOAL_WHOLE_BODY_PRIORITY_EXISTS`, instead of storing two
  goals that track one number (VW-459, #456).
- A sessions-per-28-days goal now counts training days, not recorded sessions: a day with
  several exercises logged as separate sessions counts once. The count is taken from the
  lifter's local calendar day. Any accepted session-count goal made under the old count is
  retired on upgrade, and unaccepted ones are removed, so `goal.propose_targets` offers a new
  one in days (VW-460, #455).
- A calibrating goal's chart now says in the plot what it is waiting on ("1 more comparable
  session", or the set it needs) instead of titan's generic "No band yet", so the full goal card
  no longer repeats it in a sentence underneath. The compact per-lift card, whose chart has no
  such note, keeps the sentence (VW-444).
- The per-rep velocity bars on the live page, the two-Voltra stage and the pinned strip now
  colour by the set's own stop instead of a fixed 10/20/30%. The bands sit at one third, two
  thirds and all of the stop: 6.7 / 13.3 / 20% for strength, 3.3 / 6.7 / 10% for power, and
  10 / 20 / 30% for hypertrophy or no goal. The hero's amber and red lines move with them, so
  bars, lines and the red background agree. During a rest the strip keeps the finished set's
  own bands (VW-448).
- The dashboard picks up `@titan-design/react-ui` 0.20.0, which changes three things you can
  see. A goal still calibrating draws its readings as plain dots, the next target as a hollow
  dot, the starting ramp as a dashed line, and the weeks ahead hatched. A goal card on a
  narrow screen moves its marks under the name and wraps a long name rather than cutting it
  off. The pinned strip colours its bars by loss from the set's best rep, the same as the live
  page, with taller bars and one label row (VW-432, VW-433, VW-429).

- The live page's rest timer now counts down after every set, not only when the plan set a
  rest. Without a planned rest it counts down the training-goal default `timer.start` uses
  (150 s strength, 105 s hypertrophy, 120 s otherwise, and up to 60 s more when the last set
  reached its stop in fewer reps than the one before). A caption under the ring says "Default
  rest" so a derived length never reads as the coach's. Before, an unplanned session got a
  count-up with no target (VW-441).
- The live page's red "stop" now comes from the exercise's training goal, the same threshold
  the server's `velocity_loss_exceeded` fires at: 20% velocity loss for strength, 30% for
  hypertrophy, 10% for power, and 30% when the plan names no goal. A set started with its own
  threshold is judged by that number. Before, the single-Voltra stage never went red on
  velocity loss at all (only on a form breakdown), and the dual stage and rest recap went red at
  30% for every goal. A form breakdown (a range-of-motion or dropped-negative alarm) still stops
  the set. From two thirds of the stop (13.3% strength, 20% hypertrophy, 6.7% power) the
  stage reads amber, so every goal gets a warning before the red; a range-of-motion or tempo
  warning also reads amber. The rest recap's Fatigue tile uses
  the same rule and now also reflects range-of-motion and tempo breakdown (VW-440).
- `timer.start` with no `durationMs` now uses the plan's rest for the current exercise when
  the coach set one. It used to ignore it and take the training-goal default (150 s strength,
  105 s hypertrophy, 120 s otherwise), so a 90 s planned rest ran as 105 s or longer. The
  coach's number is never auto-extended; `restBasis.source` reads `explicit_plan` for it. The
  dashboard's rest countdown uses the same rule, so the tool and the wall give one number
  (VW-441).

- The `#/goals` page leads with one goal card instead of a header block over a chart (VW-385).
  The title row carries the lift, its priority mark, a PR star and the verdict, with the reason
  for the verdict one hover away on the pill. Below it sit the block-end target, the gap to it
  and one cell per week standing on the chart's own week columns, and the chart marks next
  week's target as a hollow dot. `Goal met` and `Beyond goal` now show as themselves rather than
  as the nearest pace word. The per-lift cards carry the same summary over a week-column chart,
  and both card grids fill as many columns as fit: four across a 1920px wall, three at 1440, one
  on a phone (`@titan-design/react-ui` 0.18.0).
- Connecting now waits for the Voltra to accept the connection (`@voltras/node-sdk` 0.15.0,
  VW-415, #441). A first pairing asks the lifter to accept on the device, so `device.connect` can
  take up to 30 seconds; meanwhile `device.get_state` reports
  `connectionState: awaitingAcceptance` and the dashboard badge reads ACCEPT ON DEVICE
  instead of OFFLINE. A refusal, or no answer in time, is a `CONNECTION_REFUSED` error that
  tells you to accept on the device and try again; the server never retries on its own.
- After connecting, setters refuse with `DEVICE_STATE_UNKNOWN` until the device has reported
  its current settings, rather than writing over a state nobody has seen.
  `device.connect` returns `stateConfirmed` and `device.get_state` returns
  `state_confirmed` so you can tell. Stops are never held back this way.
- Stopping the cable now reports whether the device confirmed it. `device.unload`'s
  `read_back.verdict` is `confirmed` when the device reported the release, and
  `unconfirmed` (call it again, check the cable) when it did not. `set.end` still saves the
  set when the stop is unconfirmed or cannot be sent, and adds `motor_stop` and a
  `motor_stop_note` saying so. A spoken "stop" the device did not confirm is answered with
  "Check the cable, the weight may still be on" instead of "Weight off", and its
  `deterministic_stop_triggered` event carries `release: unconfirmed`. A forced
  `system.lease_acquire` counts an unconfirmed release as a slot it could not unload, so
  it refuses unless `acceptLoadedDevice: true` is also passed.
- The device's per-set duration on `set_ended` is named for what it is: the whole set's
  pull moving time. `device_set_summary.rep_duration_ms` is now `total_pull_moving_time_ms`
  and `meta.device_set_rep_duration_ms` is now `meta.device_set_pull_moving_time_ms`.
- `set.live_metrics`' `latestInProgress` carries the device heartbeat under its real names:
  `meanPullForceTenths`, `meanReturnForceTenths`, `meanReturnSpeedMmPerSec` and
  `pullVolumeRawTenths`. Each is a per-rep mean the device repeats until the next rep, not
  a live or peak reading. The speed is new: the old velocity field was read from the wrong
  place and meant nothing. `pullVolumeRawTenths` grows through the set and is not a weight.
- The dashboard's current-set weight comes only from the device's weight setting. It used
  to fall back to the heartbeat's "target weight", which turned out to be a per-set
  accumulator, so with no weight setting known it now shows a dash instead of a wrong number.
- The goal trajectory chart is drawn on a recessed plane with a lit bottom lip, a labelled
  value axis and gridlines, and its band edges are interpolated rather than joined
  straight (`@titan-design/react-ui` 0.17.1, VW-401). A goal whose committed and stretch
  targets are the same number — every goal still calibrating — draws that band as a single
  ramp edge and merges the two target labels into one, instead of stacking two labels over
  a band with no width.

### Fixed

- On a phone the per-lift goal cards on `#/goals` fit the screen again. They were about 80 px
  wider than the page, so the right edge was cut off: a long lift name, the status mark and the
  goal figure ran out of view. A long name now wraps inside the card (VW-454).

- The goals page's Bodyweight tile showed the oldest weight of the last 30 days as the latest
  one, and the bodyweight goal's status judged that oldest reading, so a cut's trend read
  backwards. It now shows and judges the newest reading (VW-451).
- A bodyweight goal's band now starts at the goal's own start weight on week 1 of its block,
  instead of re-centring on the last 30 days' mean on every read. A cut's loss line and a
  maintenance corridor now stay where the goal set them. A 28-day session commitment's band
  holds flat at the count committed to, not today's count. The page draws no bodyweight
  chart yet, so this shows only in the goal-progress data and its status (VW-451).
- A lifter climbing on the programmed ramp no longer reads `stalled`. The plateau check
  called any two weeks within 5% of their middle value a plateau, and the ramp itself only
  moves about 5% in two weeks, so the ideal lifter was told they had stalled. A lift now
  counts as a plateau only when its recent climb is also under a quarter of the programmed
  weekly step: a flatline, not a slowdown. On the goals page a climbing lifter now reads
  `on_track`, or `behind` when they climb slower than the band. Three weeks at the same top
  load, or a noisy run around one load, still read `stalled`. `history.trend` reports the
  run behind the call as `plateau.flatline`, and its `plateau.verdict` moves from `plateau`
  to `none` for a climbing lift. Its `isPlateau` still reports the detector's own answer
  unchanged. The `volume` metric is NOT covered: it keeps the old rule, because the
  programmed step is a load and has no volume equivalent (VW-452, #452).
- A lift goal's band now starts where the goal did. The goals page drew each band from the
  lifter's latest top load, so the line restarted wherever they were now and moved with them
  on every read. A lifter who climbed 100 to 146 lb saw a band starting at 146 and was judged
  against it. The band is now anchored at the goal's own start value on week 1 of its block.
  Today's history still decides whether it is the programmed ramp or the lifter's own
  fitted slope. Pace verdicts change with it: a lifter well above where the goal began now
  reads `ahead` instead of `on_track`, and one well below it reads `behind` (VW-449).
- The goal trajectory now starts where the band starts, and the current week has its reading
  (VW-421). A goal's weeks are calendar weeks (Monday to Sunday, UTC): week 1 is the week the
  starting set was lifted in. Before, weeks were counted in seven-day steps from that set, so
  the first week's lift fell off the chart and every later lift was drawn one week early. The
  week a reading is drawn on, the current week, the band row it is judged against, which
  readings count toward `goal_met` / `beyond_goal`, and a new target's `endsAt` all use that
  one calendar. Existing targets are not rewritten; their `endsAt` keeps the date it was
  stored with. `dashboard:preview -- goals` also dates its target on its first session, where
  it was a day later (VW-422).
- `device.exit_guided_load` now releases the cable (`@voltras/node-sdk` 0.15.0, VW-415, #441). It
  used to report success while the device stayed loaded. `device.unload` remains the stop
  the device confirms.
- `npm run docs:captures`'s dual-Voltra screenshot no longer 404s partway through (VW-389).
  Opening the page as soon as the scenario started raced the mock adapter's connect-time rep
  against the wall dashboard's kiosk auto-navigate-to-summary, landing the capture on a
  session that had not finished yet. Screenshots are also now reproducible byte-for-byte
  across two runs on one machine, for every shot whose content is not itself real-time (four
  of eight, guaranteed). The other four render a value — a pace ETA, a session timestamp, a
  rep-shape curve — the server computed from its own clock, which no local capture-time
  freeze reaches, so whether a given run's PNG matches the previous one is down to timing:
  it can come out identical when the underlying value happens to coincide, and differ when
  it doesn't.

### Added

- PR stars now actually appear on the goals page (VW-384). A reading on a lift target is a
  personal record when it is strictly greater than every earlier reading for that lift
  inside the window the page already shows — `history.trend`'s lookback, clamped to a
  declared new chapter. The goal-coach plan states no definition of its own, so that is the
  one in use, and it is the same one the e1RM badge already used: matching a load repeats a
  performance rather than passing it, so a tie is not a record, and the first reading in the
  window is not one either because there is nothing behind it to beat. Loads set before the
  window, or before a chapter boundary you declared, are not counted as earlier. Session
  counts and bodyweight readings are never marked: neither is a performance with a record to
  beat.
- You can now see that star without a device. The mock driver takes a `--goal` option that
  drives the whole loop — declare the lift as a priority, take the coach's band and accept
  it, work a set at your current top load and then a heavier one — and every set a mock run
  records now carries the load and training mode it was performed at, which also gives
  `goal.propose_targets` a start value to read.

- The dashboard now has a `#/goals` wall page (VW-355): your declared priorities, the
  coach's committed/stretch band as a trajectory chart with PR stars, a per-lift table, a
  muscle-priority rollup, and a whole-body panel with the priority rail. Bodyweight only
  shows once a bodyweight goal has an actual reading logged against it.
- The Sunday sitting now reads the scale against your committed bodyweight goal and says
  whether it is worth acting on (VW-376). `goal.weekly_review` takes the week's readings,
  the phase you declared and that week's check-in, and comes back with the observation —
  what you actually moved per week, against the band you accepted — plus an advisory that
  names the two levers, intake and activity, and sizes neither. A week that is under the
  noise floor, still settling after a phase change, holding a one-day water jump, or flat
  late in a cut while you report sticking to the plan proposes nothing and says which rule
  held it.

  **It proposes; you answer.** Call it again with `accepted`, `declined` or `ignored` and
  the answer is recorded against the proposal it answers. A proposal you declined is never
  raised again for the same week at the same urgency — it can come back next week, or
  sooner if the signal widens. Nothing on the chart moves: your committed and stretch
  values are read and never rewritten, and the diet phase you declared is never touched.

- A weekly Sunday check-in for hunger, diet-plan adherence and sleep quality (VW-374).
  `profile.log_weekly_checkin` records each on the same low/medium/high scale
  `session.checkin` already uses, and every field is optional — you can log a week with
  nothing to report, which is different from never checking in at all.
  `profile.get_weekly_checkin` reads a week back. Hunger is the input that matters most
  here: it is what a future rate advisory will use to tell an intake problem from an
  activity one. Sleep is recorded for context only and never drives anything on its own.

- A long-running recomposition now gets asked whether it is still the right label (VW-369),
  at the second block boundary and every boundary after that until you answer. At a block
  boundary, `plan.complete_workout` and `plan.next_workout` carry a `recompReAsk` alongside
  the goal re-ask. It speaks up on any of three things: the phase has reached its second
  block boundary, you are down 7% or 10% of the weight you started the phase at, or you
  have reported yourself a rung leaner than you did at the start. It offers a switch to a
  declared fat-loss or gain phase, or keeping the recomposition on the target you declared,
  and `profile.respond_recomp_advisory` files your answer.

  **Nothing about your phase changes either way.** The declared phase is a record of what
  you were doing, so the server never rewrites it: accepting records that you agreed, and
  `profile.set_diet_phase` is still the only thing that switches a phase. Decline it and
  the same evidence is not raised again until a later block boundary or a stronger signal.
  Scrolling past it is not an answer, though — a recomposition has no natural end, so the
  one question that exists to end it keeps coming back until you say something. When it
  stays quiet it says which test it failed, so silence is never ambiguous.

- A recomposition now has a bodyweight target you declare, and it decides what "on track"
  means from week 1 (VW-378). `profile.set_diet_phase` requires `recompMode` whenever the
  phase is `recomposition`: `hold` to stay inside the maintenance corridor of plus or minus
  2% of your starting weight, or `slow-loss` to come down deliberately at 0.5% a week while
  you keep training hard. `goal.propose_targets` reads it, so the bodyweight goal band you
  are judged against is the one you asked for rather than a default. The band itself landed
  earlier (VW-365) but nothing could reach the slow-loss line until now; a recomposition
  declared before this change keeps the hold corridor until you say otherwise.

  **You declare it; the scale is never read for it.** Under a hold target there is no rate
  on the scale to infer an intent from, so the server asks instead of guessing. Passing
  `recompMode` for any other phase is refused, because nothing would ever consult it.

- After a technique reform, your old PRs stop being the number to beat (VW-361).
  `exercise.mark_new_chapter` declares that a movement itself changed — a reformed squat
  depth, a new grip, a corrected bar path — and from that point the e1RM PR check,
  `history.trend` and `progression.get_for_exercise` all read from the boundary forward.
  A load you set with the old technique can no longer win, and the first session after the
  boundary is reported as a fresh baseline rather than as a drop. Nothing is deleted or
  hidden: the older sets are still there, and `exercise.retire_chapter` undoes the
  declaration and gives you the full history back.

  **You declare it; nothing detects it.** There is no inference here on purpose — nothing
  the server can see tells a genuine reform from a bad week, and guessing wrong would
  quietly erase PR history you earned. `goal.new_chapter` now files the same declaration,
  so a goal target and the exercise behind it can never disagree about where the chapter
  started.

- A declared chapter boundary now also reaches the comparability engine behind
  `session.readiness`, `session.strength` and `progression.get_for_exercise` (VW-380,
  follow-up to VW-361): a pair with one set before the chapter start and one after it is
  refused with the same re-introduction reframe used for an exercise swap, rather than
  being compared as though the technique never changed. A pair entirely on one side of the
  boundary compares exactly as before.

- `profile.set_diet_phase` now accepts `recomposition` as a fourth diet phase, alongside
  `fat-loss`, `gain` and `maintenance` (VW-363). It runs on maintenance's arithmetic
  throughout — the autoregulation tolerance table applies no widening or tightening for it,
  same as maintenance — since RP treats recomposition as a maintenance-calorie strategy
  rather than a fourth physiology.

- You can now tell the coach what you want to emphasise, and it sets the numbers (VW-350).
  `goal.declare_priorities` takes priorities in your own terms — "get bench up", "grow my
  arms" — as muscles or lifts at `specialize`, `maintain` or `deprioritize`, and takes no
  target value at all. `goal.propose_targets` then picks the metrics, reads your start
  value out of your own history (never typed), and returns a band with a committed edge
  and a stretch edge, each labelled with how much evidence is behind it: `cold` is the
  programmed ramp with no claim about strength gained, `ramp` is the weekly increment,
  `own` is your own fitted slope. `goal.accept_target` fixes it, `goal.list` shows every
  priority with its targets, `goal.retire` ends one with an outcome, and
  `goal.new_chapter` marks where a technique change restarts the comparison.

  Two rules are worth knowing before you use it. **A target does not move once you accept
  it**: the coach will not raise it when you are ahead, will not lower it when you are
  behind, and a second acceptance is refused — retiring it with an outcome is the honest
  way out. **The band is never shaded to match what you agreed to**: the committed value
  is the conservative edge of the range, the stretch is the optimistic one, both are
  shown, and reaching past the stretch edge is allowed only with an explicit
  acknowledgement that leaves the drawn band exactly where it was.

  Declaration guardrails advise and never block. More than two specialized items warns;
  in a fat-loss phase the coach OFFERS to move a specialized item to maintenance and
  waits for your answer, which is recorded so the same offer is not made twice; changing
  a priority inside a block warns, as does dropping one you have held for less than two
  mesocycles. Whatever you declared is what gets stored.

- The wall dashboard gains `GET /api/goals` and `GET /api/goal-progress?priorityId=`
  (VW-352, G5 of the goal-coach plan): every declared priority with its accepted targets
  and a rollup verdict across them, and — for one priority at a time — the full per-target
  progress view, with its weekly trajectory band, status, entry-depression confounder, and
  (for a lift) the plateau read. The band is re-derived fresh off the same reads
  `goal.propose_targets` runs, never a second copy of that arithmetic, so the two can never
  disagree. An unknown or retired `priorityId` 404s the same shape `GET /api/plan-tree` does.

- `profile.log_bodyweight` now records four optional leanness inputs alongside the weigh-in
  (VW-364): a self-reported visual band (`high`, `moderate`, `lean`, `very-lean`), a waist
  tape in inches, an absolute body-fat percentage, the source that produced it, and free
  text for how a scan was actually run. `profile.get_body_metrics` reads them back. The
  band and the tape come back raw — a waist measurement is a trend on its own and nothing
  here converts a circumference into a percentage. Every body-fat reading comes back marked
  display-only, with the accuracy tier of its source, that source's published error, and
  the citations behind both, so an absolute number is never shown as if it were a
  measurement. A change between two readings from the SAME source renders with an explicit
  error band: a move no bigger than the band reads "no measurable change" rather than a
  direction, and a pair from two different sources renders no comparison at all and says
  why. The server still never asks you to go and get measured; it records what you offer.

- `coaching.explain` gains a `diet.rate_autoregulation` topic (VW-377): how bodyweight-trend
  autoregulation works per the RP corpus — a weekly check-in cadence with a half-week floor
  before any change, why a single off-target reading is ignored when the trend is already
  converging, the two-axis (deviation × slope) read that sets how urgent a course correction
  is, and the named confounds (salt/water retention, a diet-phase transition, a
  menstrual-cycle-linked shift) that should quiet a reading rather than trigger a reaction.
  States plainly that the source material is about calories and this server prescribes none —
  it names the two levers, intake and activity, without sizing either — and that the 7-day
  mean smoothing window is this server's own engineering choice, not RP's.

### Changed

- The goals page now shows each lift and each muscle priority as its own card rather than as a
  full-width row (VW-386, titan 0.16.0). A lift card leads with the next milestone as reps by
  load, says which week it is due, carries its status in the upper right, and draws the
  trajectory against the committed and stretch lines across the whole mesocycle — so the label
  and the numbers sit together instead of at opposite edges of a wall display. A personal
  record is marked with a star on the card that set it. A muscle card lights that muscle on a
  small figure, says how many of its lifts are on track, and lists each contributing lift with
  its own next milestone; a lift due in a different week than the rest says so, and the others
  stay quiet. The cards lay out four across at 1920 and reflow below that.

- The dashboard now draws on titan 0.15.0 (VW-345, #431). Status badges on the planner page sit
  on a wider pill — 12px of padding either side instead of 8, and 4px above and below
  instead of 2 — so a label like `completed` reads as a chip rather than as tight text.
  The session-summary page's fatigue colours (the e1RM trend line's change figure and the
  next-session recommendation) now resolve against the surface they are drawn on instead
  of a palette fixed when the page loads, so they follow the theme; the three colours
  themselves are unchanged today. The muscle chips, the outline pills and every button
  label keep the size and colour they had — the dashboard names its own solid-button label
  colour, so titan's contrast change does not reach it. Newly available to the dashboard,
  not yet used anywhere: a goal-trajectory chart, a muscle strip, and a wall-sized body
  map.

- Finishing the last workout of a block now asks about your declared priorities instead of
  quoting the free-text goal on file (VW-359). `plan.complete_workout` and
  `plan.next_workout` name each priority and how many mesocycles you have held it, offer
  the three answers — keep, restate, re-architect — and show the bands each priority would
  get for the NEXT block, derived from your history exactly as `goal.propose_targets`
  derives them. Nothing is written and no target you already accepted is re-banded: an
  accepted target comes back listed as skipped, because the re-ask re-proposes and never
  silently lowers a number you committed to. If you would be switching a priority held for
  fewer than two mesocycles, or changing one still bound to the block that just ended, the
  prompt says so before you decide. A lifter who has declared no priorities gets the same
  free-text prompt as before.

- Relabelling a maintenance run as a recomposition no longer throws away your comparison
  history (VW-366). Sessions tagged `maintenance` and sessions tagged `recomposition` now
  count as the same training context, so every trend, PR and progression basis that was
  matched before the relabel stays matched after it. A pair that spans the two labels says
  so in its reasons, rather than quietly appearing as if nothing changed. `fat-loss` and
  `gain` are untouched: each still only compares against itself, and a session with no
  declared phase pairs exactly as it did before.

- `isometric.measure_max` now runs its own warm-up ramp and inter-trial rest instead of
  leaving both to the coach (VW-294). By default it runs two brief submaximal pulls — one
  cued at roughly 50% effort, then one at roughly 75% — before the trial loop,
  standardising the approach to a maximal isometric attempt (Comfort et al. 2019, as
  applied by Yeh et al., PLoS One); pass `warmup: false` to skip it. Every hold in the
  sequence, warm-up pulls included, now shares the same rest, which defaults to 2 minutes
  — the standardised inter-trial rest for maximal isometric testing (Maffiuletti et al. 2016) — up from 90s; `restMs` still overrides it. The warm-up pulls report their own
  `effortLevel` and `peakForceLbs` under a new `warmup` field and never join `trials`, the
  best-2 selection, or the stored assessment: the tool cannot verify actual effort, so a
  warm-up pull is a cue, not a controlled variable. See the [isometric guide](/guides/isometric#warm-up-ramp-measure-max-only)
  for the full sequence.

- Spoken output no longer plays over itself (VW-170). `system.speak` and the automatic
  coaching cues now share one queue, so a cue that fires while the trainer is mid-sentence
  waits its turn instead of layering on top and making both unintelligible. A `system.speak`
  call therefore returns when its line starts, which may be after the line ahead of it has
  finished. `interrupt: true` is unchanged and still immediate: it cuts off what is playing,
  drops what is queued, and speaks now — which is what keeps the spoken "stopping" ack on the
  voice safety phrase instant. A line dropped that way reports `spoken: false` rather than
  failing.

- `vbt.rir` and the weekly report's `RIR (final rep, ...)` line now read a lifter's own
  fitted RIR-velocity curve (VW-298) when one exists for the exercise, instead of always
  running the general `estimateRIRWithProfile` regression (VW-310). Every result now names
  its `basis`: `'fitted'` reads the individually-validated curve — two lifters with
  different curves get different RIR for the same velocity — or `'profile-estimate'` with
  no such curve, which now carries the same caveat `rir_velocity.target` already returns
  with no fitted curve, and is labelled so in the report line rather than reading as a
  precise number. Jukic, Prnjak, McGuigan & Helms (_Eur J Appl Physiol_, 2023) found
  velocity-loss-to-RIR agreement unacceptable at every load tested, so the general model was
  never a proximity-to-failure claim; the labels now say so. The repo-wide guard from VW-302
  now passes with zero tracked exceptions: both call sites route through
  `rir-velocity-tools.ts`, the one path already licensed to relate a velocity to RIR.

- `metrics.compute strength.e1rm` now solves for the load at a minimum velocity threshold
  fitted to your own history, where one exists, instead of the same 0.17 m/s for everybody
  (VW-299). `baselines.recalc` searches for the threshold that would have made the fewest
  percentage points of 1RM prediction error across this exercise's own sessions, and stores
  it as `optimalMvt` beside the error it achieved, the number of sessions behind it, and
  `optimalMvtObservedV1rm` — the velocity you were actually recorded at on your heaviest set
  to failure, which is the threshold this replaces. That velocity is a poor threshold: it is
  not stable between sessions (Banyard, Nosaka & Haff 2017: ICC 0.42 and CV 22.5%, against
  ICC 0.99 for the 1RM itself), while fitting to minimise error cut absolute e1RM error to
  2.8% against 4.9-5.5% (Fitas et al. 2024). Every e1RM now reports `mvtBasis`, so an
  estimate resting on the general population threshold says so rather than reading like a
  personalised one. An exercise with sets to failure in fewer than three sessions is not
  fitted and keeps the old behaviour exactly. The schema gains the fitted columns on
  `exercise_baselines` (v23); nothing is back-filled.

- Isometric history is now per lifter and per exercise (VW-280). Every stored assessment
  records who was tested, on what, and during which session, so `directionHistory` on
  `isometric.measure_imbalance` and the peak-force baseline on both it and
  `isometric.measure_max` read one lifter's own tests of one exercise. Before this, a
  guest's pull and the owner's pull at a different joint decided each other's
  consistent/fluctuating label and inflated each other's SEM, which made a real strength
  change harder to detect. Assessments recorded before this change carry no lifter, so
  they cannot join anyone's series: they are excluded from both reads and reported in a
  new `legacyUnkeyed` count rather than dropped silently. The schema gains the three key
  columns on `isometric_measurements` (v21); nothing is back-filled.

### Added

- The wall dashboard gains `GET /api/muscle-recovery` (VW-332, #415, B5 of the body-map
  plan): for each of the 15 titan muscle groups (VW-328), when you last trained it, how
  many whole days ago that was, the entry-depression read from that session, and whether
  that session matched or beat the previous **comparable** one on load times reps. Muscles
  you have not trained inside the trailing 56 days report nulls rather than a stale date.
  **It computes
  no recovery window, in any unit, and it never will**: the research behind it looked for a
  citable per-muscle one and found only training-frequency bands that vary by training age
  and say nothing about one athlete on one day, so a projected return-to-ready moment would
  be a number nobody measured. What you get instead is what was observed — elapsed days,
  the entry-depression percentage with its own confidence, and the performance benchmark.
  When no comparable prior session exists the benchmark is `null` with a reason that says
  which piece was missing: nothing prior recorded, a prior at a different load, or a prior
  that differed in something else (side, device settings, physical setup, training phase).
  Those three are reported separately because they are not the same answer. Internal
  plumbing for the body-map page (VW-323) — no page renders it yet.

- The wall dashboard gains `GET /api/muscle-week` (VW-329, B2 of the body-map plan): how
  many working sets each of the 15 titan muscle groups (VW-328) got this week, and whether
  that reads as `under`, `maintenance`, `productive` or `over`. Untrained muscles are
  present with zeros, so a future body-map figure can paint every muscle. `?weekStart=`
  picks a past week by any ISO instant inside it; the week starts Monday 00:00 UTC, the same
  boundary `history.weekly_volume` uses. Sets count target-only (B47) — toward the
  exercise's PRIMARY muscle group only, never a share to its secondary groups — and only
  your own working sets with reps recorded count, never a guest's and never a mock-adapter
  set. `lastTrainedAt` reaches back past the week itself, so a muscle you last trained a
  fortnight ago still reports a date rather than a gap. **The MEV/MAV/MRV numbers it
  classifies against are population defaults, not yours**, which is why every response says
  `landmarkBasis: "population-default"` out loud: discovering your own landmarks from your
  own history is a separate piece of work (VW-146) that has not landed. Nothing here
  suggests adding sets or taking a deload. Internal plumbing for the body-map page (VW-323)
  — no page renders it yet.

- The wall dashboard gains `GET /api/muscle-plan` (VW-331, B4 of the body-map plan): for
  the active training week, planned vs. done working sets per titan muscle group (VW-328),
  plus the still-untrained planned exercises per muscle. Every one of the 15 titan slugs is
  present with zeros when nothing is planned or trained for it, so a future body-map figure
  can paint every muscle. `doneSetsThisWeek` counts target-only (B47): a set counts toward
  its exercise's PRIMARY catalog muscle group only, the owner's own working sets only, never
  a mock-adapter set, scoped to the calendar week `weekStart` names. 404s
  `{ error: 'not_found' }` when no training week is currently active. Internal plumbing for
  the body-map page (VW-323) — no page renders it yet.

- The dashboard can now answer "which muscles are getting stronger" in one read, at
  `GET /api/muscle-strength` (VW-330). For each of the 15 body-map muscles it lists the
  exercises that target it, each with its best estimated 1RM over the last 12 weeks, that
  estimate's error band, the fitted weekly slope, the plateau verdict, and whether your most
  recent session was a personal record. Only your own working sets with reps recorded count,
  never a guest's and never a mock-adapter set — the same scoping `/api/muscle-week` and
  `/api/muscle-plan` use. Two limits are built in rather than papered over: a
  bilateral exercise reports your left and right sides as separate rows, never averaged into
  one number, and a muscle is only called stronger or weaker when at least two different
  exercises move the same way. That flag reports agreement of direction, not size — no
  published threshold says how big a load trend has to be to count, so none is applied. Under
  six months of declared training the rows carry an early-phase flag, because a rising
  estimate that early is as much skill as muscle; nothing is hidden, it is labelled.

- The database can now hold the priorities you declare and the targets the coach derives
  from them (VW-349, schema v27). A priority is your own sentence turned into a row — a
  muscle or a lift, at `specialize` / `maintain` / `deprioritize`, over a horizon — and a
  target is the coach's band for one metric of it, carrying the committed and stretch
  values, what the band was derived from, and the diet phase and tier it was derived
  under. A target is FIXED once accepted: nothing can quietly lower the number you agreed
  to, and the only exits are retiring it with an outcome or declaring a new chapter after
  a technique change. Retiring a priority ends its live targets as `abandoned` rather than
  deleting them, so a goal you set and stopped chasing stays visible as a fact about what
  you attempted. Existing databases migrate additively and read as zero priorities — no
  default is manufactured on your behalf. Internal only for now: no tool reads or writes
  either table yet (that is VW-350).

- `coaching.explain` gains a `meso.goal_setting` topic (VW-357): how a goal is set from
  stated priorities (specialize / maintain / deprioritize) rather than a typed number, why
  the coach's proposed band shows `committed` as its low edge and `stretch` as its high edge
  with neither shaded, the specialization mechanics (how long a priority is held, why a
  fat-loss phase disables it except for beginners, why recomposition runs on maintenance
  calories), the 3-month re-ask horizon, why targets are fixed for the mesocycle with
  programming adapting around them instead, the quiet-per-set/loud-per-meso praise cadence,
  and why a technique reform resets old PRs to "don't count".

- `sessions.catalog_version` is now stamped at `session.start` (VW-328, B1 of the body-map
  plan, #401): every new session records which version of the catalog-to-titan muscle map
  (`src/exercises/muscle-map.ts`) was in effect, so a future re-classification is
  detectable rather than silently rewriting historical per-muscle rollups. Internal only —
  no tool exposes the map or the field yet.

- A training week now carries its prescribed phase (VW-326): `plan.week.create` accepts
  optional `phaseType` (free text, e.g. "deload"), `isDeload` and `weekIndex` (the mesocycle
  week, distinct from `orderIndex`), and `plan.week.list_for_block` and the wall dashboard's
  plan-tree view return them alongside the rest of the week. `isDeload` defaults to `false`
  and `phaseType`/`weekIndex` are omitted when not set. No migration: the columns already
  existed unused since v6.

- You can now log bodyweight (VW-327). `profile.log_bodyweight` records a reading —
  `bodyweightLbs`, an optional `measuredAt` (defaults to now) and an optional `note` — and a
  second reading logged for the same instant corrects the first rather than creating a
  duplicate. `profile.get_body_metrics` reads the series back newest-first, optionally limited
  to the last `sinceDays` days, and reports `sevenDayMeanBodyweightLbs` — the mean of the last
  7 days of readings — once at least 3 of them exist. Storage only: no trend, rate or verdict
  is computed on top of it.

- `metrics.compute`'s `strength.e1rm` result now reports `isPR` and `priorBest` (VW-314):
  whether the fresh estimate beats this exercise's own best e1RM on record, and what that
  prior best was. It shares its comparison with the dashboard hero card's PR chip through
  one helper, so the two never disagree about what counts as a PR. `priorBest` is `null`
  and `isPR` is always `false` when there is no prior session to beat — including the first
  time this exercise is estimated, or a bare `{ load, reps }` call with no `exerciseId` to
  look history up against. No schema change.

- `metrics.compute` gains a `fatigue.verdict` pipeline (VW-313): the same multi-dimension
  fatigue verdict the live dashboard's fatigue card renders — an aggregate state
  (good/slowing/grinding/form-breakdown), an aggregate tone, and per-dimension tones for
  velocity loss, ROM and tempo. A ROM or tempo alarm overrides a clean-looking velocity
  reading, so a cheat rep (cutting ROM while keeping cable speed up) cannot hide behind an
  honest-looking velocity number. `null` for a set under 2 reps, which has no baseline yet
  to judge a rep against. Prefer this over `fatigue.set`, whose `FatigueIndex` is deprecated
  upstream. No schema change.

- The wall dashboard's session rail now shows how the session is tracking against its plan
  (VW-290). When a workout template is attached, the rail reports how many planned sets are
  left, the clock time the plan projects you to finish at, and the elapsed time against the
  planned budget. `session.get` returns the same estimate as `sessionPace`. Every planned set
  is costed at its rep target and target tempo plus its own rest, falling back to the rest
  default for its training goal when the coach set none, and the rest after the last set is
  not counted — the session ends on the last rep. It is an estimate from the plan, never a
  measurement, and a session with no plan attached gets no pace and no footer at all rather
  than a budget nobody prescribed. Warm-up, probe and technique sets do not burn down the
  remaining count. No schema change.

- Changing the weight while the cable is under tension now says so (VW-170). On 2026-09-07 a
  set was run at 31 lb after 45 lb was asked for and confirmed: the firmware keeps the load it
  engaged until the cable next goes slack, and nothing reported the gap — the tool said `ok`
  and `device.get_state` read back the new number. `device.set_weight` now returns a
  `weightChangeWarning` sentence, and the spoken weight fast-path puts the same sentence on its
  `voice_command_applied` event, whenever a set is open or the cable reads loaded. The change
  still goes through; this is a warning, never a refusal, because adjusting mid-set is a normal
  drop-set move.

- Every coaching line spoken aloud is now captioned on the wall dashboard's rest stage
  (VW-289, #394). A cue is heard once, from across the room, over whatever else is playing — miss
  it and it was gone. The rest stage now prints the latest line under a fixed dwell, labelled
  `COACH` when the trainer chose to say it and by the cue category when a deterministic cue
  fired it, so a lifter can read what they only half-heard. The caption's height is reserved
  whether or not anything was said, so the rest timer never jumps. A new `coach_line` push
  event carries the same line to any channel consumer; `system.speak` and the cue emitter
  share one emission point, so one utterance is one event.

- The session-completion page now shows an expected rep RANGE for a velocity-loss-terminated
  set, never a single predicted number (VW-301, #392). Each set on `GET /api/session-summary/:id`
  gains `expectedRepRange` (`expectedLow`/`expectedHigh`/`median`/`n`/`basis`), built from this
  lifter's own reps-to-threshold history at the exact same exercise and load, once at least 3
  qualifying historical sets exist — the same evidence floor this server already treats as the
  minimum for a personalised statistical claim. Jukic et al. 2023 found reps completed to a
  fixed velocity-loss threshold at a fixed load carry 95% limits of agreement of roughly
  -5.4/+5.5 reps between sessions, so a point estimate here would overstate how precisely this
  can be predicted. `null` below the minimum, never a fabricated range. Live-rail rendering
  deferred: needs a distinct titan affordance, tracked separately.

- A working set at a prescribed absolute load now gets checked for %1RM drift against the
  lifter's own load-velocity profile (VW-300). A fixed-load prescription is only worth what
  it was programmed as while the lifter's own strength stays put — Jimenez-Reyes et al. 2021
  (PeerJ, DOI 10.7717/peerj.10942) tracked a fixed-absolute-load group programmed at 80% 1RM
  drift, with no velocity check in the loop, to ~64% 1RM over 8 weeks, with the load on the
  plan never changing. The session-completion screen's per-exercise card gains `loadDrift`
  (`programmedPct`, `impliedPct`, `deltaPct`, `reason`), set when the measured velocity at
  the exercise's programmed load implies a %1RM that has drifted 10 or more percentage
  points from the programmed one; `null` otherwise. `set_ended` carries the same finding as
  a new `load_drift` block when the just-closed set was performed at that programmed load.

- `session.start` now takes an optional `preSessionCarbs` for recording a self-reported carb
  context against the session (`{ level: 'low'|'normal'|'high', hoursSinceLastMeal? }`), and
  `session.checkin` can set or correct it afterward (VW-307). Absent means never reported and
  is never defaulted. `report.weekly` lists it per session when present; nothing in
  `metrics.*` or `coaching.*` consumes it yet — the VW-278 research note found the fuel axis
  is not observable from telemetry, so a recorded n-of-1 context is the only path to using it
  later. The schema gains `pre_session_carbs_level` and `pre_session_carbs_hours_since_meal`
  on `sessions` (v25); nothing is back-filled.

- `isometric.measure_hold` now gates a hold against the joint angle its exercise's dynamic
  form actually peaks force at (VW-296). Joint angle dominates what an isometric hold
  predicts about the dynamic lift: an isometric squat predicted the full squat at r=0.864
  held at 90 degrees of knee flexion but only r=0.597 held at 120 degrees (Lum, Haff &
  Barbosa 2020, _Sports_ 8(5):63). Pass `exerciseId` and `setupAngleDeg` (the angle the
  current physical setup implies — the tool cannot measure it) and the new `jointAngleGate`
  on the result reports `comparable`, `angle_mismatch`, or `angle_unverified` when either
  input is omitted or the exercise carries no known angle — checked against a small,
  deliberately sparse static table, not a schema field. A mismatch warns by default (the
  hold still runs); pass `strict: true` to refuse it as `INVALID_INPUT` instead. Omitting
  both new inputs reproduces the exact pre-VW-296 behaviour. See the
  [isometric guide](/guides/isometric#joint-angle-gate-measure-hold-only) for the full gate.

- `metrics.compute` now reports fatigue on two separately named axes instead of one blended
  number (VW-306). `session.perturbation` and `session.fatigue` both gain `fatigueAxes`, with
  `entryDepression` — how far the session's opening working set sat below the lifter's own
  prior sets at the same load, a recovery-state read — beside `lateSessionDecay`, the slope
  across that session's matched-load sets, which is the cost of work already done. A depressed
  entry with a flat decay and a normal entry with a steep decay are opposite situations that
  the single decay number read as nearly the same, and they call for opposite advice. Each axis
  carries its own confidence and names which of rest, load, eccentric setting and warm-up state
  its comparison actually held fixed, so an unmatched comparison is visible rather than
  silently averaged in; an axis with nothing to compare reports `null`, never `0`. New
  `coaching.explain` topic `live.fatigue_axes` carries the citations and states plainly that
  neither axis supports an inference about what the lifter ate. Every existing field on both
  pipelines is unchanged.

- An RIR prescription now converts into a velocity target from the lifter's own fitted
  curve (VW-298). Two new tools: `rir_velocity.fit` re-fits one lifter's RIR-velocity
  relationship for one exercise from their working sets that ended at failure in the 70-90%
  band of estimated 1RM, and `rir_velocity.target` turns a reps-in-reserve number into the
  velocity that lifter actually moves at. `coaching.explain` on `live.rir_estimation` now
  takes `exerciseId` and `rir` together and returns the same target inline. Two lifters with
  different curves get different velocities for the same RIR, which is the point: individual
  RIR-velocity models predicted a later session within under 2 repetitions of mean error
  across 70/80/90% 1RM, while general models failed at 70% and were only acceptable at 80-90%
  (Jukic, Prnjak, Helms & McGuigan, _Physiological Reports_, 2024). A lifter without enough
  history gets a stated caveat and NO number rather than a group curve that is wrong in the
  part of the band most working sets sit in. New `rir_velocity_models` table (schema v24);
  nothing is back-filled, because a fit only exists once it is run.

- The weekly report guide now says outright why the `RIR (final rep, est.)` line is not the
  same claim as an `rir_velocity.fit` curve: it is the per-rep `vbt.rir` estimator (VW-134),
  and neither it nor anything else in this server converts velocity loss straight into a
  reps-in-reserve number without a lifter's own fitted curve. Jukic, Prnjak, McGuigan & Helms
  (_Eur J Appl Physiol_, 2023) found the agreement between velocity loss and percentage of
  max reps completed unacceptable at every load tested, with errors over 10% — velocity loss
  is a volume-control dial, not a proximity-to-failure estimate. A new repo-wide test now
  fails CI if any code path pairs a velocity-loss input with an RIR output outside the fitted
  model (VW-302); `vbt.rir`'s own velocity-loss-to-RIR call is a tracked, pre-existing
  exception, not yet folded into the fitted model.

- `device.set_eccentric`'s description and `coaching.explain` now frame eccentric overload
  as a stimulus-cost knob, not a growth multiplier (VW-303). The largest available synthesis
  (49 studies, 773 participants) found accentuated eccentric loading's chronic strength and
  hypertrophy adaptations statistically similar to constant-load training, while acutely
  raising lactate, growth hormone, RPE and eccentric-phase muscle activation for the same
  result (Zhang, Weakley, Li, Marcos-Frutos & García-Ramos, _Sports Medicine_, 2026). New
  `coaching.explain` topic `live.eccentric_overload_cost` carries the citation and the
  mechanical caveat that the rep right after an overloaded one runs slower for reasons
  unrelated to fatigue.

- `progression.get_for_exercise`'s `sideSplit` now names which figure to actually compare
  between the two sides (VW-304): `comparisonMetric` is `peak_force` when the last session
  recorded it on both arms, `top_weight` otherwise, and `comparisonBasis` says why in prose.
  Peak force is preferred because it is the only metric with good bilateral reliability in
  unilateral isometric squat testing (Bishop et al. 2021, JSCR 35(2S): CV 5.44-5.70%, ICC
  0.93-0.94) — this server's own sideSplit had no such statement before, so a reader could
  not tell whether the 30 vs 45 lb gap it already showed was a reliable comparison or not.

- `timer.start` now defaults its rest duration by training goal when no explicit
  `durationMs` is given (VW-297): >=120s for a `strength`-intent exercise (Grgic et al.
  2018 — over 2 minutes needed to maximise strength gains in trained lifters), 90-120s for
  `hypertrophy` (Singer et al. 2024 — no further benefit past 90s), or a named
  conservative default when no plan or training intent is attached. It then extends,
  unprompted, when the exercise's most recent completed set reached its velocity-loss
  stop threshold in fewer reps than the set before it — Singer et al. 2024's proposed
  mechanism is volume-load preservation, observable as reps-to-threshold holding steady
  set to set. The result reports `restBasis` (`source`, `intent`,
  `prevRepsToThreshold`, `currRepsToThreshold`, `extensionSeconds`) so the basis for the
  duration is always visible; an explicit `durationMs` is never overridden.

- Every stored isometric assessment now names the equation its asymmetry math used
  (VW-295). Bishop et al. (2018) found nine asymmetry equations in circulation with no
  consistent test-to-equation mapping, so a percentage with no equation behind it is not
  comparable to anything read later. The equation is fixed by which tool ran — never a
  per-call choice — and is stamped on the row at write time: `isometric.measure_imbalance`
  writes `standard-percentage-difference`, and `isometric.measure_max` writes none, since
  it computes no comparison to name one for. `directionHistory` and the peak-force
  baseline on both tools now exclude a stored occasion computed under a different
  equation from the one read, counting it in a new `otherEquation`, alongside
  `legacyUnkeyed`. The schema gains `asymmetry_equation` on `isometric_measurements`
  (v22); nothing is back-filled.

- The wall shows what an isometric assessment measured, once the hold overlay closes
  (VW-264). After `isometric.measure_imbalance` (or `isometric.measure_max`) finishes, a
  card carries each side's peak force, the left/right percentage and the verdict — and
  stays up for twenty seconds, or until the next set starts or the next hold begins,
  whichever comes first. Until now those numbers went back to the MCP client only, so a
  lifter standing at the rig heard their own asymmetry only if the model chose to speak
  it. The verdict is the same comparison the tool result makes — the difference against
  this athlete's own trial-to-trial spread, never a fixed percentage — and a result whose
  setup geometry could not be compared reads "verdict withheld" with the reason, not "no
  difference found". Delivered as a new `isometric_result` push event, documented in
  `docs/push-events.md`.

- New `accountability.preview` tool (VW-291, #380): runs the same read-only dry run as
  `accountability.state` and, when the protocol would send something, also renders the
  actual coach message — the Sunday anchor, a miss-recovery prompt, a ghost nudge, or a
  realign opener — from live reads (`report.weekly` adherence, `plan.next_workout`, the
  rolling 28-day count). It sends nothing and writes nothing, so it is safe to call any
  time to answer "what would the coach say right now".
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

- The wall dashboard now flags an auto-armed set with a compact "AUTO" badge (VW-265):
  on the live header while the set is active, naming the mechanism (guided load vs your
  own reps) on hover, and on the rest recap's set-just-completed row once it closes.

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

- Added a coach-facing [weekly report guide](/guides/weekly-report) for
  `report.weekly` (VW-292, #378): what the header's rolling 28-day count and adherence trend
  mean, per-session blocks, progression suggestions labelled "not applied", why
  `setting_coerced` never appears in flags, the check-in section, and how the adherence
  trend feeds `accountability.state`. Linked from the coach-report guide and the guides
  index.

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
