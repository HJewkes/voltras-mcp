# truecoach-retro

A one-off retrospective over the TrueCoach set log (VW-546). It reads the truecoach-mbox
extraction and a hand-built exercise map, runs six checks, and writes one markdown report.
Nothing here touches the store or a device.

```bash
npm run retro:truecoach -- <records.jsonl> <checkins.jsonl> <exercise-map.json> --out <report.md> [--programme-split YYYY-MM-DD]
```

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

| rule                                                                                     | where                 |
| ---------------------------------------------------------------------------------------- | --------------------- |
| A work row is dated and not above a warm-up divider; a block with no divider is all work | `log-rules.ts`        |
| A training day is a date with at least one work row                                      | `log-rules.ts`        |
| A prescription is fixed sets x reps with an optional load; lines add up per block        | `prescription.ts`     |
| A block misses when it reports fewer sets than prescribed or a set under the rep floor   | `missed-targets.ts`   |
| Two consecutive missed sessions on one muscle is the MRV proxy                           | `underperformance.ts` |
| A 10% top-load drop on two main lifts in one week, or a 10-day gap, ends a meso          | `meso.ts`             |
| A bodyweight phase ends at a slope sign change held 3 weeks or a 21-day check-in gap     | `bodyweight.ts`       |
| The programme split is the first day of the first month written mostly load-first        | `periods.ts`          |

## What it imports from `src/`

`analytics/flatline`, `analytics/goal-history` (`topLoadAtReps`, `modalRepCount`,
`slopeStandardError`), `analytics/target-verdict`, `analytics/training-days`
(`trainingDaysOf`, `trainingGaps`), `analytics/bodyweight-trend` (the 0.25% edge),
`analytics/cumulative-loss` (the diet-fatigue band), `dashboard/read-models/muscle-week`
(`classifyWeeklyVolume`, `POPULATION_VOLUME_LANDMARKS`) and `exercises/muscle-map`. From
workout-analytics: `analyzeTrend`, `detectPlateau`, `estimateE1RMFromReps`.
