# Component inventory

Source in `app/src/components/`. "Generic" means reusable on other pages unchanged;
"page-specific" means shaped around this page's contract.

| Component | Role | Props | Contract fields consumed | Scope |
|---|---|---|---|---|
| `SessionPage` | Page layout: header, glance list (phone, ≥2 exercises), bands, legend, record | `summary`, `units`, `onUnits` | `exercises[]` | page-specific |
| `SessionHeader` | When, how long, totals, open-session banner, RIR marker, unit toggle | `summary`, `units`, `onUnits` | `session.startedAt/endedAt`; `exercises[].setCount, workingSetCount, totalReps, volumeLbs, name`; `sets[].endedAt` | page-specific |
| `EffortWithheld` (in SessionHeader) | Dashed "RIR withheld" marker, shown once per page | none | none (states a deliberate absence) | generic |
| `UnitToggle` (in SessionHeader) | lb/kg segmented control | `units`, `onUnits` | none | generic |
| `GlanceList` | Phone summary: one line per exercise with glyph, verdict, next load; links to the band | `exercises`, `units` | `exerciseId`, `name`, `verdict.state/tone`, `progression.delta/targetWeightLbs` | page-specific |
| `ExerciseRow` | One band: head + verdict + strip + next time | `exercise`, `units` | `exerciseId`, `name`, `topWeightLbs`, `volumeLbs`, `bestRepVelocity` | page-specific |
| `VerdictPanel` | Verdict word, glyph, dimension chips, partial-telemetry note; the no-verdict state with its reason | `exercise` | `verdict.*`, `verdictSetIndex`, `maxVelocityLossPct`, `workingSetCount`, `sets[].setPurpose/velocityLossPct/index` | page-specific |
| `DimensionChip` (in VerdictPanel) | VEL / ROM / TEMPO pill with a tone glyph | `label`, `name`, `tone` | `verdict.dimensions.*` | generic (also suits Live) |
| `SetStrip` | Evidence: per-set velocity-loss bars against VL10/20/30, reps with ▼/▲ against target, load, e1RM; verdict-set ring; hatched no-data columns | `exercise`, `units` | `sets[].*` (except times and range), `verdictSetIndex`, `verdict.tone`, `progression.targetRepsLow/High` | page-specific |
| `StripLegend` | One key for every strip on the page | none | none | page-specific |
| `NextTime` | Arrow, target load, verb, scheme, server reasoning, usual-range line, disagreement note, drift note; or the "No recommendation" box | `exercise`, `units` | `progression.*`, `progressionNote`, `loadDrift.*`, `sets[].expectedRepRange`, `verdict.tone` (via compareSignals) | page-specific |
| `SignalNote` (in NextTime) | "≠" sentence when verdict and progression point opposite ways | `exercise` | `verdict.tone`, `progression.delta/targetRepsLow/High`, `sets[].repCount/weightLbs/setPurpose` | page-specific |
| `DriftNote` (in NextTime) | Load-drift flag: implied vs programmed %1RM plus the server reason | `drift`, `units` | `loadDrift.*` | page-specific |
| `SetTable` | Wall raw record: every set grouped by exercise, with rest, duration, usual reps, e1RM, verdict-set note | `exercises`, `units` | every `sets[]` field except `id` (key only); `expectedRepRange.basis` as title | page-specific |
| `SetList` | Phone raw record: one dense line per set | `exercises`, `units` | as SetTable | page-specific |
| `ToneGlyph` | Shape and colour per tone: check circle, triangle, octagon, dashed ring for none | `tone`, `size?` | a `Tone` value | generic |
| `Absent` | Dashed box: title plus reason, for a deliberately missing value | `title`, `reason?` | any null-with-reason field (`progressionNote`) | generic |
| `Gap` | Inline "— no data" for a single missing number | `label?` | any nullable number | generic |
| `ServerText` | Renders server prose; in kg mode converts lb tokens and marks them as converted | `text`, `units`, `className?` | `progression.reasoning`, `loadDrift.reason` | generic |

Helpers (not components): `derive.ts` (e1RM, rest, totals, absent-verdict reasons,
`compareSignals`, scored-set heuristic) and `units.ts` (lb↔kg, server-text converter).
