# Component inventory

Source: `app/src/components/` (plus `SessionPage.tsx`). "Generic" means reusable on other
pages without change; "page" means specific to session-complete.

| Component | Role | Props | Contract fields consumed | Scope |
|---|---|---|---|---|
| `SessionPage` | Page composition: header, glance list (phone), exercise rows, record (wall). Sets `--strip-slots` so strips align | `summary`, `unit`, `onUnitChange`, `layout: 'wall' \| 'phone'` | `exercises[]`, `session.id` | page |
| `SessionHeader` | Title, time line, session stats, RIR-withheld stat, unit toggle, open-session banner | `summary`, `unit`, `onUnitChange` | `session.startedAt`, `session.endedAt`; sums of `setCount`, `workingSetCount`, `totalReps`, `volumeLbs`; `sets[].weightLbs`/`loadLabel` (unloaded-set note), `sets[].endedAt` (last set) | page |
| `UnitToggle` | lb / kg radio group, 44 px targets | `unit`, `onChange` | none | generic |
| `GlanceList` | Phone-only roll call: verdict and next load for every exercise, links to cards | `exercises`, `unit` | `name`, `exerciseId`, `verdict.state/tone`, `progression.targetWeightLbs/delta`, `sets[0].index` (anchor) | page |
| `ExerciseRow` | One exercise: verdict, evidence, next time (and set list on phone). Left border carries tone | `exercise`, `sessionId`, `sessionSets`, `unit`, `layout` | `verdict.tone` | page |
| `ExerciseTitle` | Exercise name; Unattributed styling and explanation | `exercise` | `name`, `exerciseId` | page |
| `ExerciseTotals` | Phone-only totals line under the verdict | `exercise`, `unit` | `workingSetCount`, `setCount`, `totalReps`, `topWeightLbs`, `volumeLbs`, `bestRepVelocity` | page |
| `VerdictBlock` | Verdict word with glyph, VEL/ROM/TEMPO chips, "◆ Reads set #N", or "No verdict" with reason | `exercise` | `verdict.*`, `verdictSetIndex`, `workingSetCount` | page (verdict word and chips could move to a shared verdict module with Live) |
| `DimensionChip` (internal) | One dimension: glyph and label, tone word in title | `label`, `title`, `tone` | `verdict.dimensions.*` | generic with Live |
| `ToneGlyph` | Shape-coded tone: circle-check, triangle-bang, octagon-cross | `tone`, `size` | a tone | generic |
| `EvidencePanel` | Set strip and the fatigue, strength and usual-range facts | `exercise`, `unit` | `maxVelocityLossPct`, `sets[].velocityLossPct`, `sets[].weightLbs/repCount` (e1RM), `expectedRepRange.expectedLow/High/n`, `topWeightLbs`, `workingSetCount` | page |
| `SetStrip` | Per-set columns: VL% bar against VL10/20/30 lines, reps, load, "#N warm/tech", ◆ on the verdict set; hatched bar when telemetry is missing | `sets`, `verdictSetIndex`, `verdictTone`, `unit` | `sets[].index/velocityLossPct/repCount/loadLabel/weightLbs/setPurpose` | generic (usable on Live for the sets so far) |
| `NextTime` | Next load, scheme and action chip; rep chips; agreement note; server reasoning; load-drift flag; or "No recommendation" with note | `exercise`, `sessionId`, `unit` | `progression.*`, `progressionNote`, `loadDrift`, `verdict.tone` (agreement), `sets[]` (scoring) | page |
| `RepPips` (internal) | "Reads reps vs 12–15" with one ↓/✓/↑ chip per loaded working set and a count of unscored unloaded sets | `exercise` | `progression.targetRepsLow/High`, `sets[].repCount/weightLbs/setPurpose` | page |
| `AgreementNote` (internal) | ⇄ note when verdict and progression point opposite ways | `exercise` | `verdict.tone`, `progression.delta` | page |
| `LoadDriftFlag` | Direction shape and word, planned → implied % of max, reason | `drift`, `unit` | `loadDrift.*` | generic (Plan page) |
| `LbTag` | Marks server prose as written in lb when viewing kg | none | none | generic |
| `SetRecordTable` | Wall raw record: every set grouped by exercise, with totals and usual-range basis in the group header; footnote on ◆, e1RM and RIR | `summary`, `unit` | every `sets[]` field; `expectedRepRange.basis`; exercise totals; `verdictSetIndex` | page |
| `SetList` | Phone raw record inside each card (native `<details>`, open by default) | `exercise`, `session`, `unit` | same per-set fields | page |

Shared modules: `derive.ts` (e1RM, trends, rep scoring, agreement, rest, session sums; pure and
unit-tested), `format.ts` (unit conversion, display delta, clock and duration).
