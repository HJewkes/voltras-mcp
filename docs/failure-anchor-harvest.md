# Failure-anchor harvest (VW-174 / B59)

`failure_anchors` had DDL since schema v7 and a reader (`selectAnchors`) since VW-116, but no
writer. `anchorCount` was therefore structurally 0, no baseline could leave `PROVISIONAL`, and
`vbt.rir`'s baseline-maturity axis could never clear. This is the writer.

## Harvest, never prescribe

The product does not ask anyone to train to failure, and nothing built on this table may start.
The RP review puts the training benefit of true failure at trivial-to-nil (ES 0.12, CI crossing
zero), so prescribing it would take on real risk to buy approximately nothing, for a model's
convenience. What happens instead is retrospective labelling: reps that were recorded anyway are
examined at set close, and a set that already stalled is marked as such.

Two consequences that are accepted deliberately:

- Incidental failures skew toward lighter loads and later sets. That biases the anchor slow, which
  biases RIR estimates conservative — the safe direction, and correctable later from the recorded
  `set_index_in_session` / `session_position_sec`.
- A cautious lifter may never produce one and stays uncalibrated indefinitely. That is a better
  outcome than pushing them to failure to satisfy the model.

Do not gamify a harvested anchor. No streaks, no badges, no "you hit failure again" — an anchor is
a measurement, and celebrating it converts a passive read into an incentive.

## The criterion, version `failure-harvest@1.0.0`

Implemented in `src/store/failure-harvest.ts`, pure, with every threshold in one exported const
block. Velocities are normalised to m/s first (`normaliseVelocityToMps`), so pre-VW-160
device-native rows and current rows produce the same verdict.

A set is a **candidate** when its final rep's concentric mean velocity is at or below
`stallFraction` (0.70) of the fastest non-first rep, and the set has at least `minReps` (4) reps.
Warm-ups and shorter sets are `not_candidate` and nothing is written for them.

A candidate is a **failure** only when BOTH hold:

1. the last `decayWindow` (3) concentric mean velocities are non-increasing within
   `decayTolerance` (5 %), and
2. the final rep's ROM is no more than `maxRomCollapse` (35 %) below the set's median rep ROM.

Anything else is an **abort**, stored with its inputs and never counted.

| Threshold        | Value | Why                                                                                 |
| ---------------- | ----- | ----------------------------------------------------------------------------------- |
| `minReps`        | 4     | Below four reps there is no decay trajectory to read; matches the shape floor.      |
| `stallFraction`  | 0.70  | A 30 % velocity loss — the proximity-to-failure band VBT work uses for cable work.  |
| `decayWindow`    | 3     | One slow rep is noise; three non-increasing reps are a lifter running out of rope.  |
| `decayTolerance` | 0.05  | Telemetry and rep-to-rep variation produce small upticks inside a genuine decay.    |
| `maxRomCollapse` | 0.35  | A failure rep is slow but roughly complete; a half-rep finish is a different event. |

### Why the decay trajectory is a hard filter

Injury looks like failure. A lifter racking early because something hurt produces a short-ROM
termination that matches a naive stall test exactly, and yields a spuriously **fast** anchor — which
then tells them they have reps left when they do not. That is the one failure direction the protocol
calls dangerous, so a candidate with no plausible preceding decay is classified `abort`, not
down-weighted.

## Storage and identity

`putFailureAnchor` upserts on `UNIQUE (set_id, filter_version)` (added in the additive v11→v12
migration alongside `exercise_baselines.last_anchor_at`). Re-evaluating a set under the same filter
version rewrites its verdict in place; bumping `FAILURE_FILTER_VERSION` adds a row beside the old
one, so a threshold change is re-scorable against history rather than destructive of it. `setup_id`
is written NULL — `exercise_setups` has no writer either (VW-119), and `selectAnchors` filters
`setup_id IS NULL`.

Only candidates are written. A `not_candidate` row per closed set would be noise, not history.

## Where it runs

- **Set close.** `recalcBaselineForSet` in `src/tools/set-tools.ts` harvests, then recalculates, in
  one best-effort envelope, so the derivation sees the new anchor in the same `set.end`.
- **Back-fill.** `baselines.recalc { reharvest: true }` re-runs the filter over the key's stored
  working sets and returns the verdict tally, then derives. Idempotent at a fixed filter version.
