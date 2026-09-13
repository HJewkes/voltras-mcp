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
- Rest between trials, same side: 90s (`DEFAULT_REST_MS`, `src/schemas/isometric.ts:18`)
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
