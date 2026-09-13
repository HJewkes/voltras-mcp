# Isometric assessment

The `isometric.*` tools measure how hard someone can pull against the cable while holding
still, rather than while moving through a rep. The protocol drives one max-effort hold, or
a set of them with rest between, and reports peak and plateau force per hold
(`src/state/isometric-protocol.ts:1-20`). `isometric.measure_max`'s own description states
what the result is used for: the mean plateau force across the best trials drives an
inferred starting working weight for programming
(`src/tools/isometric-tools.ts:111-126`) — see [the calibration caveat](#the-calibration-caveat)
below before treating either number as a settled measurement.

Before any hold, the caller pre-configures the device: a low-resistance mode with the
weight set as low as the SDK allows. `device.set_weight` clamps at 5 lb — 0 lb isn't
settable — so the isometric tools ask for a low, not zero, load and none of them changes
device settings on your behalf; that's on the caller
(`src/schemas/device.ts:46`, `src/tools/isometric-tools.ts:36-42`, `src/tools/isometric-tools.ts:98-99`).

## One hold, or a protocol that blocks

[`isometric.measure_hold`](/reference/isometric) runs exactly one hold — no trial loop, no
rest wait — and returns as soon as it's done. It exists so a coach can pace the assessment
hold by hold instead of blocking through an entire protocol; call it again for the next
hold when the athlete is ready (`src/tools/isometric-tools.ts:92-109`).

[`isometric.measure_max`](/reference/isometric) and [`isometric.measure_imbalance`](/reference/isometric)
loop that same single-hold primitive with the protocol's rests, and both **block** until
they finish (`README.md:385`). `measure_max` runs N trials of M-second holds on one slot
with rest between trials; `measure_imbalance` runs that same protocol on two slots in turn,
with an additional rest between sides, and computes the asymmetry between them
(`src/tools/isometric-tools.ts:111-160`). The defaults, all from the input schema:

- Hold duration: 5s (`DEFAULT_DURATION_MS`, `src/schemas/isometric.ts:14`)
- Trials per side: 3 (`DEFAULT_TRIALS`, `src/schemas/isometric.ts:16`)
- Rest between trials, same side, `measure_imbalance`: 90s (`DEFAULT_REST_MS`,
  `src/schemas/isometric.ts:18`)
- Rest between EVERY hold `measure_max` runs — warm-up pulls included (VW-294): 2min
  (`DEFAULT_MAX_REST_MS`, `src/schemas/isometric.ts:29`) — see
  [Warm-up ramp](#warm-up-ramp-measure-max-only) below
- Rest between sides (`measure_imbalance` only): 120s (`DEFAULT_BETWEEN_SIDES_REST_MS`,
  `src/schemas/isometric.ts:20`)

`measure_imbalance` also defaults `testNonDominantFirst` to `true`: when `dominantSide` is
given, the non-dominant side is tested first, to control for within-session fatigue
(`src/state/isometric-protocol.ts:504-519`, `src/schemas/isometric.ts:81-83`).

Because the multi-trial tools block for minutes, every wait inside them — the hold itself,
the between-trial rest, the between-sides rest — runs under the same device write-lease
fence every device-driving tool uses. If another client takes the lease mid-assessment, the
wait aborts instead of running out, the tool call fails with `LEASE_LOST`, and the device is
left unloaded — the athlete may still be pulling against it at that moment, so dropping the
load is the one write worth making on the way out
(`docs/push-events.md:388-393`, `src/tools/isometric-tools.ts:608-624`).

## Joint-angle gate (`measure_hold` only)

An isometric hold measures force at exactly one joint angle. What that single number
predicts about the exercise's DYNAMIC form depends heavily on whether it was held at the
angle where the dynamic lift actually peaks force: Lum, Haff & Barbosa (2020, _Sports_
8(5):63) found an isometric squat predicted the full squat at r=0.864 held at 90 degrees of
knee flexion, but only r=0.597 held at 120 degrees — the same correlation, at a joint 30
degrees off, cut nearly in half (`src/state/isometric-protocol.ts:696-710`).

`isometric.measure_hold` cannot measure the physical setup's angle itself — there is no
angle sensor on the rig — so the gate is a comparison the CALLER feeds it: pass `exerciseId`
and `setupAngleDeg` (the angle the current setup implies, however the coach or lifter
arrived at it) and the tool checks `setupAngleDeg` against a small static table of known
peak-force angles, keyed by the catalog's own exercise ids
(`EXERCISE_PEAK_ANGLES`, `src/state/isometric-protocol.ts:720-726`). Deliberately sparse:
today it holds one entry, the squat's 90 degrees from the citation above, and a made-up
angle for an exercise nobody has sourced is worse than an honest gap.

`jointAngleGate` on the result reports one of three verdicts
(`src/state/isometric-protocol.ts:744-828`):

- `comparable` — `setupAngleDeg` sits within `JOINT_ANGLE_MISMATCH_THRESHOLD_DEG` (15
  degrees) of the exercise's known peak angle.
- `angle_mismatch` — it does not. WARNS by default (the hold still runs, and the reading is
  still returned) — pass `strict: true` to REFUSE it as `INVALID_INPUT` before the hold
  begins instead (`src/tools/isometric-tools.ts:700-706`).
- `angle_unverified` — the gate did not run: no `exerciseId`, no `setupAngleDeg`, or the
  exercise carries no known angle. Never treated as a match or a mismatch, the same
  DEGRADE-never-refuse-silently posture the bilateral setup-geometry gate takes.

The 15-degree threshold is a heuristic, not a value the citation states directly — Lum et al.
compared exactly two angles, 90 and 120 degrees apart, and the threshold sits inside that gap
pending a study with more than two angles to interpolate between
(`src/state/isometric-protocol.ts:728-741`). Nothing here is persisted: `setupAngleDeg` is a
per-call input, pairing in spirit with the human-declared setup card
([`exercise.confirm_setup`](/reference/exercise), VW-275) rather than living in its storage —
no schema migration backs it.

## Warm-up ramp (`measure_max` only)

Before VW-294, a coach had to pace a warm-up by hand: call `isometric.measure_hold` a
couple of times at a lighter cue, wait, then call `isometric.measure_max` for the real
protocol. `isometric.measure_max` now runs that ramp itself, unprompted, by default: two
brief submaximal pulls — one cued as roughly 50% effort, then one at roughly 75% — ahead
of the trial loop, standardising the approach to a maximal isometric attempt (Comfort et
al. 2019, as applied by Yeh et al., PLoS One) (`src/schemas/isometric.ts:30`,
`src/tools/isometric-tools.ts:1220-1238`).

Every hold in the sequence — both warm-up pulls and every real trial — shares the SAME
`restMs` gap, defaulting to the standardised inter-trial rest for maximal isometric
testing, 2 minutes (Maffiuletti et al. 2016) (`src/schemas/isometric.ts:21-29`). One rest
concept governs the whole ready-then-test sequence rather than a second, unstated
ramp-specific interval.

The tool cannot verify actual effort — a warm-up pull is a cue over the phase-push
channel, not a controlled variable — so its readings are reported separately, under
`warmup` (`effortLevel`, `peakForceLbs`, `holdMs` per pull), and never join `trials`, the
best-2 selection, the inferred working weight, or the stored assessment
(`src/tools/isometric-tools.ts:1186-1192,1255-1262`). Pass `warmup: false` to skip the
ramp entirely — for a coach-paced bench sitting, or to reproduce the pre-VW-294 timing.

## Phase pushes

Every hold — from `measure_hold` directly, or one iteration inside `measure_max` /
`measure_imbalance` — emits four `isometric_phase` events in order, so a dashboard or a
coach's own cueing knows when to tell the athlete to pull and when to stop
(`docs/push-events.md:139-172`):

| `phase` | Fires                                      | Means            |
| ------- | ------------------------------------------ | ---------------- |
| `ready` | before the frame listener attaches         | get set          |
| `go`    | the instant the capture window opens       | pull now         |
| `hold`  | one second in, when a peak starts counting | hold max         |
| `stop`  | the capture window closed                  | stop and release |

The one-second mark is `PEAK_AFTER_MS`, the same constant that gates trial validity below
(`src/state/isometric-protocol.ts:141-146`). A three-trial `measure_max` run emits twelve of
these events total — four per hold, three holds
(`docs/push-events.md:169-172`).

## Reading a result: peak, plateau, and what makes a trial valid

Each hold analyzes the force samples captured during it into a peak (the highest
instantaneous reading) and a plateau (the mean force across a 500ms window centered on that
peak) (`src/state/isometric-protocol.ts:36-37,139`). A trial is only valid when it clears
three gates, checked in order (`src/state/isometric-protocol.ts:172-267`):

1. Force rises continuously from the start of the hold to the peak — no meaningful dip
   along the way.
2. The peak occurs after the first second of the hold (`PEAK_AFTER_MS`).
3. The plateau window averages at least 90% of the peak value.

A trial with fewer than one sample fails outright with `no samples captured`; the other
three gates report their own specific `invalidReason` string (`force did not rise
continuously from onset`, `peak occurred at Xms (expected > 1000ms)`, or `plateau X lb below
90% of peak Y lb`) so a coach can tell the athlete what to change on the next attempt
(`src/state/isometric-protocol.ts:178-267`).

One more check runs across the whole set of trials for a side, not per-trial: once there
are at least three currently-valid trials, any trial whose peak diverges by more than 15%
from the median of the others is discarded as an outlier — median rather than mean,
specifically so a single wild trial can't drag the comparison point far enough to condemn
the legitimate ones with it
(`SESSION_OUTLIER_CV_THRESHOLD`, `src/state/isometric-protocol.ts:152,278-304`).

### When there aren't enough valid trials

`meanPlateauForceLbs` (and the values derived from it) come back `null` whenever fewer than
2 trials on a side end up valid — that's the one structural failure mode to check for before
reading anything else off the result (`src/state/isometric-protocol.ts:308-315`). There's no
number to report in that case; re-run holds against the invalid ones' `invalidReason` for
what to correct.

### The numbers a valid result reports

Once at least 2 trials are valid, the tool takes the best 2 by plateau force and reports
(`src/state/isometric-protocol.ts:155-166,318-333`):

- **`meanPlateauForceLbs`** — the mean of those best 2 trials' plateau force.
- **`cvPct`** — the coefficient of variation between them, a spread/consistency check.
- **`inferredWorkingWeightLbs`** — 70% of the mean, rounded to the nearest 5 lb and clamped
  up to 5 lb (the device's own settable floor) so it's always a value the device will
  accept.
- **`inferredWorkingWeightBasis`** — what that weight is and is not, shipped with the number
  rather than only in the tool description (`src/tools/isometric-tools.ts:278-294`).

That last field exists because the weight is a **heuristic, not a validated conversion**
(VW-273). No study validates a cable-device isometric maximum as a predictor of dynamic
cable loads, no `plan.*` or `progression.*` path consumes one, and it is never a 1RM proxy.
Joint angle dominates what an isometric maximum predicts at all: an isometric squat predicted
the full squat at r 0.864 at 90 degrees of knee flexion but only r 0.597 at 120 degrees (Lum
et al., _Sports_ 2020). Held at the wrong angle for the exercise you mean to load, the number
means very little. A description is read once when the model picks the tool; the number is
read every time the result is, so the caveat travels with the number.

## What the wall shows during a hold

The wall dashboard's live page renders the phase pushes above as they arrive: a corner
overlay names the current trial number, shows the phase's own label ("Get set" / "Pull
now" / "Hold max" / "Stop and release"), and — only during the hold itself — runs a
countdown ring for the hold duration. No spoken cue accompanies it yet; that pairing
waits on a shared speech queue.

The overlay is a small panel, not a takeover — the rest of the live page stays visible
underneath it — and it tracks one hold at a time: it appears on that hold's `ready` event
and disappears the instant its `stop` event lands, with no lingering on the terminal
phase. A wall showing nothing extra during an assessment means no hold is in progress
right then, whether between trials or between sides.

<!-- src/dashboard/spa/live-page/IsometricWalkthrough.tsx -->

## Bilateral imbalance

`isometric.measure_imbalance` runs the max-force protocol on both slots and reports the
asymmetry between the two resulting means
(`src/state/isometric-protocol.ts:356-425`):

- `asymmetryPct` = (stronger − weaker) / stronger × 100, or `null` if either side lacks a
  valid mean.
- `equation` names the equation that percentage came from. It is fixed for this test type
  and is not a per-call option: the valid equation is chosen by the test method, and
  percentages from different equations cannot be compared across tests or studies.
- `direction` names whichever limb scored higher, or `null` at an exact tie.
- `intraLimbCvPct` carries each side's own trial-to-trial CV, and `noiseFloorCvPct` is the
  higher of the two.
- `real` is `true` only when `asymmetryPct` exceeds `noiseFloorCvPct`.

### Setup geometry gates this verdict too

An isometric peak force at a given cable angle is determined by anchor position, full
stop — there is no velocity fallback the way the wall's live L/R callout has. A moving
lift can still read something off velocity when force comparability is in doubt; a hold
produces exactly one number, at exactly one joint angle, off exactly one anchor position,
so if the two units are not anchored the same way there is nothing else in the trial to
fall back on. The same cable-geometry gate [the bilateral guide](/guides/bilateral#setup-geometry-gates-the-asymmetry-verdict)
describes for the live wall (Keogh, Lake & Swinton 2013, _Journal of Fitness Research_
2(2):39-48) therefore runs here too, before the verdict: `setupComparability` compares
each side's CONFIRMED `exercise_setups` signature for the exercise active on that slot.
On `setup_confounded` it carries `setupSignatures` and `setupReason`, and `imbalance.real`
/ `imbalance.direction` come back `null` — the per-side peak forces still report, because
those are facts about one side each, but reading the gap between them as an imbalance is
what gets withheld. `setup_unverified` means one or both sides had no confirmed setup to
check; that is not a mismatch, so the verdict reports unchanged.

There is no fixed percentage anywhere in that list, and that is the point (VW-270). A
difference smaller than a limb's own spread across its trials cannot be told apart from
that spread, so the comparison is against the athlete's own CV on the same test, not
against a 10% or 15% constant — those constants were removed. `interpretation` says in
words what was compared.

`directionHistory` then reports whether the same limb dominated across recent tests:
`consistent-left`, `consistent-right`, `fluctuating`, or `insufficient-history` under three
tests with a direction (`src/state/isometric-protocol.ts:427-475`). `testsCompared` says how
many stored tests carried a direction at all, and `agreementPct` the share of those that
named the more common limb. A consistent direction may warrant a closer look at that limb; a
fluctuating one is ordinary between-session variation. `directionHistory` is `null` only when
the history could not be read at all, which is not the same answer as a short history
(`src/tools/isometric-tools.ts:493-508`).

### What `directionHistory` is actually a history of

Read the scope limit before trusting the label. `isometric_measurements` carries **no
lifter, exercise or session key**, so there is no column to filter the series on — it
aggregates every isometric assessment stored in this database. It answers "has the same limb
dominated on this rig", not "has it dominated for this lifter on this joint".

That makes it meaningful only when one lifter has been testing one joint against this
store. A second lifter's assessment, or the same lifter tested at a different joint, lands
in the same series, and a `consistent-left` built out of two people's tests means nothing.
Check `testsCompared` against what you know was actually tested before acting on the
label. A schema change to key these rows properly is filed as its own task; nothing in the
current code fakes a filter it does not have.

Each side's per-trial measurements are persisted, keyed on the connected device's own id so
the series survives a `slot.swap` — no verdict is stored. The percentage, the direction and
the real/not-real call are recomputed from the stored trials on every read, against whatever
rules are current at read time (`src/tools/isometric-tools.ts:517-540`), which is what let
VW-270 change the rules without stranding a single stored row. The write is best-effort: a
store failure returns `measurementId: null` rather than discarding a result that just cost
the athlete real effort to produce (`src/tools/isometric-tools.ts:293-301`).

### What the result does not license

**No corrective unilateral work is prescribed from a detected asymmetry** — not here, not by
`coaching.explain`, not by `plan.suggest_progression`. The intervention literature does not
support it. Meta-analysed against bilateral training, unilateral training was clearly better
for unilateral jump (ES 0.89, 95% CI 0.52-1.26) and worse for bilateral strength (ES -0.43,
CI -0.71 to -0.14), while unilateral strength, bilateral jump, sprint and change of direction
were all non-significant (Liao et al., _Biology of Sport_ 2022). Unilateral work is
goal-specific: prescribe it when single-limb capacity is the goal. The evidence that any
method reduces asymmetry at all is thin — a seven-week bilateral back-squat block moved
isometric peak-force asymmetry only in the subgroup that started weaker, and several combined
and flywheel programmes improved performance while leaving asymmetry untouched (Bishop et al.
2023). The stated answer to a detected difference is consistent strength training over time.
Ask `coaching.explain` for `meso.asymmetry_interpretation` to get this with its citations.

**There is no published re-test cadence for asymmetry, and this server invents none.** No
interval appears anywhere in these tools, and none should be read into the
`insufficient-history` threshold — three tests is the point at which a direction label
becomes possible, not a schedule. The defensible rule is a decision rule: test often enough
to judge whether limb dominance is consistent across sessions. See
[the bilateral guide](/guides/bilateral#what-a-detected-asymmetry-does-not-license) for the
same two statements alongside the slot-pairing they apply to.

## The calibration caveat

Force is read off the SDK's telemetry frame and converted from the device's native
tenths-of-a-pound scale to pounds (`FRAME_FORCE_TENTHS_PER_LB`, `src/state/live-signal.ts:77`).
The isometric tools apply this conversion directly, independent of the main telemetry
bridge — and as of this writing, the assessment's empirical validity (the plateau detection,
the inferred working weight) has **not** been re-verified against hardware since that scale
was last changed. It's flagged in source for a separate calibration ticket
(`src/tools/isometric-tools.ts:744-751`).

Practically: treat `peakForceLbs` and `meanPlateauForceLbs` as the device's own reading
under its own conversion, not as a value checked against a known reference load. Trends —
this session against a past one, or one side against the other in the same session — rest
on the same conversion applying consistently and are more trustworthy than any single
absolute figure. Don't present an absolute pull force to a lifter as a calibrated
measurement.

## What to read next

- [The bilateral guide](/guides/bilateral) for slot binding and identification, which
  `isometric.measure_imbalance` depends on for a two-device session.
- The [`isometric.*` reference](/reference/isometric) for full schemas on every tool named
  above.
