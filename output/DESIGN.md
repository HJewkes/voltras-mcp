# Session complete: design

## The idea in one line

One horizontal band per exercise, read left to right in the brief's priority order:
**verdict → evidence → next time**. The raw record sits below the fold. At 1440×900 a full
four-exercise session fits in one screen with nothing to scroll for questions 1–3.

## Information architecture

| Priority | Question | Where | Size at wall |
|---|---|---|---|
| 1 | How did it go? | Left of each band: tone glyph + verdict word, three dimension chips | 44 px bold, in tone colour |
| 2 | What is the evidence? | Middle of each band: a set strip (velocity loss per set against VL10/20/30, reps against target, load, e1RM) | bars 64 px, reps 22 px |
| 3 | What do I do next time? | Right of each band: arrow + target load + verb + scheme, then the server's reasoning | 44 px load, 22 px verb |
| 4 | Every set | "Every set" table below the bands (phone: one line per set) | 15 px |

Why bands rather than cards or tabs:
- **One exercise per band lets the eye run across, not around.** Each band answers 1-2-3 for one
  exercise. Scanning down the left edge gives the whole session's verdicts. Scanning down the
  right edge gives the whole shopping list for next time. Those are the two things a tired lifter
  at 3 m wants, and they sit on the two outer edges of the screen.
- **The evidence sits between them** because it explains both: velocity bars explain the
  verdict, the rep row explains the progression.
- **The raw record is a table below the fold.** A coach reviewing later scrolls to it. The lifter
  standing back never needs it.

### Verdict and progression disagreement

The two signals are visibly separate systems:
- **The verdict wears tone colour.** Green, amber or red, with a shape: check circle, triangle,
  octagon. Its kicker says what it reads: "How it moved · worst set #13 · VL 34%".
- **Next time wears no tone colour.** It is neutral ink with a direction arrow (↑ = ↓). Its kicker
  says "Next time · reps vs plan". So a green "Good" beside a "↓ 135 lb" does not look like a
  contradiction in the same palette. It looks like two instruments.
- **The bridge sits in the strip.** The verdict set gets a tone-coloured ring on its bar. Reps
  below the plan's target get a ▼ and a dotted underline; reps at the top of the target get a ▲.
  So the bars carry the verdict's evidence and the rep row carries the progression's evidence,
  in the same columns.
- **A real disagreement gets one sentence.** When the verdict is ok but progression backs off,
  or the verdict is warn/alarm but progression adds load, a "≠" note appears under Next time:
  "**Moved well, but missed reps.** Speed, range and tempo held, yet 2 of 2 sets fell short of
  12–15 reps." (fixture 1). Agreement gets no note; silence there is deliberate.

## Layout

**Wall (1440×900; content area 1376×856 after the 64 px rail and 44 px bar)**
- Session header, one line: when and how long; totals (exercises, sets, reps, volume); the RIR
  withheld marker; the lb/kg toggle. An open session adds a dashed banner under it.
- Bands: grid `396px | 1fr | 410px`, about 170–190 px tall. Four bands, the legend and the
  header fit in 856 px (see `screens/2-full-session-wall.png`).
- A single legend line under the bands explains the strip once for the whole page, instead of
  once per band.
- "Every set" table below.

**Phone (390×844, 56 px nav placeholder at the bottom)**

The phone is designed for a different moment: the screen is in your hand, not across the
room. Reading distance is short and the width is narrow, so the order changes:
1. A compact header. Totals reflow to a 3+1 grid.
2. **A glance list**, phone only, shown when there are two or more exercises: one tappable line
   per exercise with glyph, verdict word and next load ("Grinding … ↓ 75 lb"). This is the
   wall's two outer edges folded into one thumb-length list. Each line links to that exercise's
   detail.
3. Each exercise stacks verdict → strip → next time. The strip keeps its columns; five sets
   still fit at 40 px each.
4. "Every set" becomes one dense line per set ("#3 120 lb × **12**" / "VL 14% · best 0.62 m/s ·
   e1RM 168 · usual 9–13 · 06:05 · rest 1:45") instead of a 12-column table.

## Typography

Inter (variable, bundled via @fontsource) with tabular figures on every number.

| Token | Wall | Phone | Used for |
|---|---|---|---|
| `--type-hero` | 44 | 34 | verdict word, target load |
| `--type-title` | 26 | 22 | exercise name |
| `--type-lead` | 22 | 19 | verb, reps, header totals |
| `--type-body` | 18 | 16 | banner sentences |
| `--type-label` | 15 | 14 | kickers, chips, reasoning, table |
| `--type-micro` | 13 | 12 | close-reader notes (basis, drift reason, legend) |

The 3 m test: 44 px at 1440 wide on a 55" TV is about 3.6 cm tall, readable from across a
room. Everything at 44 and 22 px is what the lifter needs from a distance. Everything at 13–15
px is for someone who walks up to the screen or is holding the phone.

## Colour and accessibility

- Tone colours (`--tone-ok/warn/alarm`) appear only on verdict glyphs, the verdict word, the
  dimension glyphs and the verdict-set ring. Never on data bars, never on progression.
- **Colour never carries meaning alone.** Every tone has a distinct shape: a circle with a
  check, a triangle with "!", an octagon with "×", and a dashed ring for "no verdict". Each also
  carries a word (the verdict label) or an aria-label (dimension chips). Rep marks use ▼/▲
  plus underline. Warm-up bars are narrower as well as greyer.
- Contrast was measured with WCAG relative luminance against both surfaces. Dark mode: ink
  15.7 / 10.2 / 6.4 :1; tones 7.5 (ok), 9.6 (warn), 6.3 (alarm); data bars 6.9; muted bars
  3.4; absent outlines 3.7. Light mode passes AA for all text tones. Warm-up bars on the light
  surface-2 are 2.8:1, but they never sit on surface-2.
- Data bars use one neutral blue. The bar does not change colour by threshold. The VL10/20/30
  dashed lines carry that, so the server's verdict stays the only judgement on screen.

## Honest about absent data

| Absence | Treatment |
|---|---|
| Set with no velocity telemetry | Hatched, dashed-outline column labelled "no data". Table: "— no data". Never a zero-height bar |
| Verdict read only some working sets | Line under the chips: "Read 1 of 2 working sets: #2 had no telemetry." |
| Verdict null, no telemetry | Dashed glyph + "No bar-speed data" + reason |
| Verdict null, no working sets | Dashed glyph + "Not scored" + "Only technique sets. Verdicts read working sets." |
| `volumeLbs` null | "volume not recorded" in italic. The header total says "excl. Face Pull (no load)" |
| `topWeightLbs` null | "no weighted load" |
| e1RM not computable (no weight, or not a working set) | "–" in the strip |
| Progression null | Dashed "No recommendation" box with the server's `progressionNote` |
| RIR / RPE | One dashed "RIR · withheld · still learning your sets" marker in the header, once per page. Not a per-exercise empty widget |
| Open session (`endedAt` null) | Kicker "Session still open"; the end time renders as a dashed "open" box; a dashed banner says the figures cover the sets so far and can change |
| Cross-session trends, all-time records | Not shown. The only "best" is the ● on the best e1RM *this session*, and the legend says so |

## kg mode

- Every weight converts at 0.4536 and rounds to whole kg: loads, top weight, volume, target
  load and e1RM.
- `loadLabel` passes through untouched when `weightLbs` is null ("damper 6", "band").
- **The progression step is not converted to a kg delta.** 5 lb rounds to 2 kg, but
  100 → 105 lb is 45 → 48 kg, so a "+2 kg" would not add up. The headline shows the target in
  kg (the number the lifter dials) and the verb reads "Add one 5 lb step".
- **Server prose** (progression `reasoning`, `loadDrift.reason`) passes through a token
  converter. (`expectedRepRange.basis` is only a tooltip and stays in lb, a known gap.) "120 lb" becomes "≈54 kg" and "115-125 lb" becomes
  "≈52–57 kg", each with a dotted underline and the original lb text in its title. The "≈" and
  underline say this is a conversion, not the server's own words.
- **The proper fix (payload ask 1)** is to stop shipping English with units baked in.

## Contract field map

| Field | Where it appears |
|---|---|
| `session.id` | Not shown. Identity for routing/history links, not for reading |
| `session.startedAt` | Header date and start time; duration |
| `session.endedAt` | Header end time and duration. Null drives the open-session treatment |
| `session.exerciseId`, `session.exerciseName` | **Dropped.** They duplicate the last-trained exercise in `exercises[]` and are null in fixture 3. See open questions |
| `exercises[].exerciseId` | React key and anchor target for the phone glance list. Null marks "Unattributed" (with `name`) |
| `name` | Band title; "Unattributed" renders in italics with a dashed "no exercise named" tag |
| `setCount`, `workingSetCount` | Header totals; table group headers ("3 working of 5 sets"); the partial-telemetry note |
| `totalReps` | Header total; table group header |
| `volumeLbs` | Band meta line; header total (sum of non-null, with exclusions named) |
| `topWeightLbs` | Band meta line ("top 120 lb") |
| `bestRepVelocity` (exercise) | Band meta line ("best rep 0.62 m/s") |
| `maxVelocityLossPct` | Verdict kicker ("worst set #5 · VL 23%") |
| `verdict.state`, `verdict.tone` | Verdict word + glyph; glance list; verdict-set ring and table note |
| `verdict.dimensions.*` | VEL / ROM / TEMPO chips with tone glyphs |
| `verdictSetIndex` | Verdict kicker; ring on that set's bar; "verdict set" in the table |
| `progression.delta` | Arrow and verb (Add / Hold / Back off); disagreement logic |
| `progression.reasoning` | Under the action line (unit-converted in kg) |
| `progression.targetSets`, `targetRepsLow/High` | Scheme ("3 sets × 10–12 reps"); ▼/▲ rep marks in the strip; disagreement sentence |
| `progression.targetWeightLbs` | The 44 px target load |
| `progression.basedOnSessionId` | **Dropped.** It equals `session.id` in every fixture. If it ever differs, the page should say "based on <date>". Not built, because there is no case to render |
| `progressionNote` | Body of the "No recommendation" box |
| `loadDrift.*` | Drift note under Next time: "Load got easier: 58% of max, planned 70%." (`impliedPct`, `programmedPct`, sign of `deltaPct`), then `reason` in small type |
| `sets[].id` | React key only |
| `sets[].index` | Table # column; verdict kicker; partial-telemetry note |
| `sets[].startedAt/endedAt` | Table Start, Set duration, Rest before (derived across the whole session, so rest between exercises shows too); last-set time in the open banner |
| `sets[].weightLbs` | Strip load row; e1RM; whether a set can be scored against the rep target |
| `sets[].loadLabel` | Shown when `weightLbs` is null; otherwise the converted weight |
| `sets[].repCount` | Strip rep row (22 px); table |
| `sets[].setPurpose` | Narrow grey bars and muted reps for warm-up/technique/probe; table Purpose |
| `sets[].velocityLossPct` | Bar height and label; hatched "no data" when null |
| `sets[].bestRepVelocity` | Table "Best rep" |
| `sets[].expectedRepRange` | Next time: "Your usual at 120 lb is 9–13 reps (from 7 past sets); 3 of 3 sets landed inside." Table "Usual reps" with `n`; `basis` is the title/tooltip. `median` is **dropped**: the brief says to show a range, never a point, and a median invites reading it as one |

Derived on the client: e1RM (Epley, working sets with a load), best e1RM this session, rest
between sets, session duration and totals, the disagreement sentence, rep marks against target,
"usual range" inside-count.

## Payload asks (two)

1. **Structured progression scoring instead of English-only reasoning.** Add
   `progression.scoring: { scoredSetIndexes: number[], hitIndexes: number[], outcome:
   "top" | "in-range" | "short" }`, and either take a `units` parameter or send a reasoning
   template with load tokens.
   *Why:* (a) kg mode can render real sentences instead of regex-converting lb text. (b) The
   strip's ▼/▲ marks and the "≠" sentence currently *re-derive* which sets were scored. In
   fixture 3 the server says "1/1 sets hit 12 reps" for an exercise with two working sets. I
   assumed it skips the band set because it has no load, but that is a guess. The server should
   say which sets it scored.
   *Replaces:* the client's `scoredWorkingSets` heuristic and the kg text converter.

2. **Last session's working sets for each exercise** (the "last session's sets" the brief says
   is available). Just `{ date, sets: [{ weightLbs, repCount, velocityLossPct }] }` for working
   sets.
   *Why:* "Next time" is far more convincing with "last time" beside it. It would add one
   micro-line under the action ("Last: 3 × 15 @ 100 lb, 13 Oct"). It is the one cross-session
   fact a lifter asks for at the machine.
   *Replaces:* nothing on screen. It adds one line in the Next time column.

Deliberately **not** asked for: per-rep velocity/ROM/tempo (too fine-grained for 3 m, and the
verdict already summarises it; it belongs on a drill-down), e1RM history (a trend chart belongs
on Review/Goals, not on a page answering "how did *this* go"), weekly sets per muscle and goals
(Plan/Goals pages).

## Chrome ideas (not built)

- The lb/kg toggle belongs in the app's status bar as a global preference. It sits in the page
  header here only because chrome is out of scope.
- The wall could auto-advance from Live to this page when a session ends, and dim the rail for
  60 s so the verdicts own the screen.
- The RIR "withheld" marker is a system-wide status ("still learning your sets: 14 of ~30
  sets"). It could live in the status bar with a progress count, not on each page.

## Open questions

- Are `targetRepsLow/High` this session's target (what was scored) or next session's? I
  treated them as both, because the reasoning text quotes the same numbers. If they can differ,
  the ▼/▲ marks need the scored target separately (folds into ask 1).
- What are `session.exerciseId/exerciseName` for: the last exercise, the "primary" one, or
  whatever the Live page last showed? I dropped them.
- Time zone: times render in the viewer's local zone. Screenshots use UTC. Should a coach
  reviewing remotely see the lifter's zone?
- An open session can still change, but the page "loads once". Should it refetch while
  `endedAt` is null?
- A single-exercise session (fixture 1) leaves the lower half of the wall for the set table.
  Should bands grow when there are only one or two exercises, for a bigger hero at 3 m?
