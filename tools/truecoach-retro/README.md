# truecoach-retro

A one-off retrospective over the TrueCoach set log (VW-546). It reads the truecoach-mbox
extraction and a hand-built exercise map, runs six checks, and writes one markdown report.
Nothing here touches the store or a device.

```bash
npm run retro:truecoach -- <records.jsonl> <checkins.jsonl> <exercise-map.json> --out <report.md> [--json <data.json>] [--programme-split YYYY-MM-DD] [--boundary-decisions <boundary-decisions.json>] [--warmup-share <percent>]
```

`--warmup-share` sets the share of the prescribed load under which a row in a block with no warm-up divider reads
as a warm-up (missed-target verdicts only); it defaults to 90.

`--boundary-decisions` reads the human's marks from the walkthrough page (`{week, choice, note}[]`,
choice `planned_deload`, `life_gap`, `unplanned_drop`, `not_a_boundary` or `null`; any other value
fails the run). Without it every gap over 10 days ends a run of regular weeks, and the report says so.
`not_a_boundary` removes a boundary from the mesos; `unplanned_drop` is a real boundary that is
neither a deload nor a gap, so it bridges nothing.

A map entry's `muscles` is its attribution table (VW-561): rows of `{ muscle, weight, target }`, weight
1, 0.5 or 0, a target always at 1. `muscle` is a titan slug (`front_delts`) or a catalog string that
fans out (`back` to lats and upper back). The report reads the table two ways. The **landmark read**
counts a set 1 toward each target muscle and nothing else (B47); every MEV/MAV/MRV band, frequency
count, missed-session run and systemic week reads it. The **dose read** adds each row's weight
(Pelland et al. 2025) and appears only in columns labelled "dose", never against a landmark. Glutes,
lats and upper back carry no band until RP's glute and back landmarks are verified. An entry with `warmup: true` counts in
neither read. An entry without `muscles` is read the pre-VW-561 way: each `primary_muscle` a 1.0
target, each `secondary_muscles` entry 0.5. The rules are in the workspace design note
`2026-09-24-vw-561-attribution-amendment.md`.

`--json` also writes every number the report computed, unrounded, for the visual walkthrough.
Its keys are listed in `RETRO_DATA_KEYS` (`src/data.ts`); `retro-data.schema.md` beside the
output describes each one.

None of the three inputs is checked in, and the repo holds no values from them: every test
fixture is synthetic. The design note and the RP digest the report cites live in the
voltras-workspace `sources/design/` tree.

## Why it is not tsx

The repo has no tsx, ts-node or vite-node, and `package-lock.json` is not regenerated on this
machine. The script imports `src/` modules by relative path, so it follows the `scripts/sim`
pattern: `tsconfig.build.json` compiles it and the `src` modules it reaches into the gitignored
`.retro-build/`, and the npm script runs the emitted JavaScript under `TZ=UTC`.

Unlike `tools/truecoach-submit`, this directory is inside the package's gates: `npm run lint`,
`npm run typecheck` (`typecheck:retro`), `npm test` and `npm run format:check` all cover it.

## The rules it applies

| rule                                                                                                                                                  | where                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| A work row is dated and not above a warm-up divider; a block with no divider is all work                                                              | `log-rules.ts`        |
| A training day is a date with at least one work row                                                                                                   | `log-rules.ts`        |
| A prescription is fixed sets x reps with an optional load; lines add up per block                                                                     | `prescription.ts`     |
| A block misses when it reports fewer sets than prescribed or a set under the rep floor                                                                | `missed-targets.ts`   |
| Two consecutive missed sessions on one muscle is the MRV proxy                                                                                        | `underperformance.ts` |
| A day counts toward a muscle's frequency only when one of its target exercises was trained; the dose column counts a secondary-only day 0.5            | `weekly.ts`           |
| A 10% top-load drop on two main lifts in one week, or a 10-day gap, ends a meso                                                                       | `meso.ts`             |
| A bodyweight phase ends at a slope sign change held 3 weeks or a 21-day check-in gap                                                                  | `bodyweight.ts`       |
| The programme split is the first day of the first month written mostly load-first                                                                     | `periods.ts`          |
| A week is regular when steady (modal sessions minus 1, 3 written-out exercises) in a run of 3 steady weeks; gaps over 10 days end a run unless marked | `segmentation.ts`     |
| Checks 1, 2, 3 and 5 are computed twice: all weeks, and regular weeks only                                                                            | `checks/segments.ts`  |
| On the confirmed mesos: restart load against the previous meso's weekly loads, the weekly-sets ramp per muscle, staleness                             | `meso-checks.ts`      |

## What it imports from `src/`

`analytics/flatline`, `analytics/goal-history` (`topLoadAtReps`, `modalRepCount`,
`slopeStandardError`), `analytics/target-verdict`, `analytics/training-days`
(`trainingDaysOf`, `trainingGaps`), `analytics/bodyweight-trend` (the 0.25% edge),
`analytics/cumulative-loss` (the diet-fatigue band), `dashboard/read-models/muscle-week`
(`classifyWeeklyVolume`, `POPULATION_VOLUME_LANDMARKS`, `LANDMARK_VERDICT_WITHHELD`),
`exercises/muscle-attribution` and `exercises/muscle-map`. From
workout-analytics: `analyzeTrend`, `detectPlateau`, `estimateE1RMFromReps`.
