# Session complete: redesign

Content area only. Chrome is a plain 64 px rail and 44 px bar on the wall, and a 56 px bar on the phone.
Screens: `screens/` (dark; `extra-*` holds the kg and light shots). App: `app/` (see `app/README.md`).

## 1. Critique of the current view

Rendered from `1-current.json` at 1440 wide.

1. **The verdict is not the hero.** "Good" is about 18 px, under a header, a section label and a
   stray green "RPE" bar. From 3 m the biggest thing on screen is the session stats strip:
   exercises 1, sets 2, reps 10. Those are the least useful numbers on the page.
2. **"RPE" is shown on a page that has no RPE.** The contract withholds effort on purpose. A
   green bar labelled RPE reads as "effort was fine", which is exactly the fake value the
   system refuses to give.
3. **Next time is coloured like a failure.** "-5 lb" in red reads as "you did badly". It sits
   directly under a green "Good" with nothing linking them, so the most important truth of
   this session goes unexplained: the bar moved well, but 5 reps against a 12–15 target
   means the load was too heavy for the planned rep range.
4. **The e1RM chart is a flat line in a 300 px tall box** with two "PR" stars. The page can't
   know all-time records, so "PR" is a false claim. "+0.0% this meso" claims a cross-session
   trend the payload doesn't carry. The legend lists "Projected", which isn't drawn.
5. **The velocity-loss bar shows one number (12%) across the full 1300 px width.** It shows the
   worst set only, with no per-set picture of fatigue building. Its labels (fresh, VL10…) are
   about 9 px monospace and can't be read.
6. **The sets list is the most legible part, and it's the least important.** It also says
   "best 0.5" without a unit.
7. **Session stats repeat the exercise stats** (1 exercise: sets 2 / reps 10 / volume 1400 twice).
   Volume prints as "1400 lb" with no separator. Duration says "1 min" next to a
   timestamp range written to the second.
8. **Colour carries everything.** Dimension dots are green circles with tiny labels, the verdict
   is green text, and next time is red text. Nothing has a shape or a word that survives
   colour-blindness or a washed-out TV.
9. **The structure doesn't scale.** One tall card per exercise, about 900 px each, means a
   four-exercise session takes four screens to scroll on a wall nobody touches.

## 2. Information architecture

The page is a **ledger: one row per exercise.** Each row reads left to right in the brief's
priority order:

```
┌ header: title · date/time/duration · exercises · working sets · reps · volume · RIR withheld · lb|kg
├ [open-session notice, only when endedAt is null]
├ ┌──────────────┬──────────────────────────────────────┬───────────────────────────┐
│ │ 1 VERDICT     │ 2 EVIDENCE                             │ 3 NEXT TIME               │
│ │ name          │ set strip: one column per set          │ 105 lb  3 × 12–15  ▲ Add 5 lb │
│ │ ✓ Good (44px) │  VL% bar vs VL10/20/30, reps, load    │ reads reps vs 12–15: 15✓…  │
│ │ VEL ROM TEMPO │ fatigue: VL first → last               │ [⇄ verdict and plan differ]│
│ │ ◆ reads set #9│ strength: e1RM first → last, %         │ plan: server reasoning     │
│ │               │ your usual: 9–13 reps (n)              │ [load drift flag]          │
│ └──────────────┴──────────────────────────────────────┴───────────────────────────┘
│   … one row per exercise, in the order first trained
└ 4 EVERY SET: the raw record table, grouped by exercise (below the fold on the wall)
```

Why rows rather than one card per exercise or one column per exercise:

- **Every exercise's verdict and next action fit the 1440×900 wall at once.** With four
  exercises the fourth row's next-time block is fully visible and its strip sits on the fold.
  The record table is the only part that needs a scroll, and it's the lowest priority.
- **Reading across a row is the argument**: what happened, why we think so, so what to do. Reading
  down a column compares exercises: all the verdicts line up on the left, and all the next loads
  line up on the right.
- It works for 1 exercise (fixture 1) through about 6. Rows grow downward; columns would run out of width.

The set strip **is** the evidence for priority 2 and also a compact form of the record:
reps, load and set number are printed under every bar. That way the wall shows the whole
session's raw shape without scrolling, and the table below only adds detail: purpose,
usual-range basis, best rep velocity, e1RM, start time, set length and rest.

## 3. Hierarchy, layout, typography

**Three type tiers by reading distance** (tokens in `tokens.css`):

| Tier | Size | Used for | Why |
|---|---|---|---|
| 3 m | 44 px heavy (verdict), 36 px heavy (next load), 28 px bold (set reps, scheme) | the answer to Q1 and Q3 | On a 55" TV at 1440 px, 44 px is about 35 mm tall, comfortably above the ~25 mm needed at 3 m |
| 1 m | 22 px names, 17 px chips and action, 15 px facts | evidence, exercise identity | Read when the lifter steps up to the screen |
| arm's length | 11–13 px caps labels, footnotes, table | the record and provenance | Coach reading later |

- **Inter Variable** with tabular figures, so numbers line up in columns and bars.
- **Tone is never colour alone.** Every tone pairs a shape with a word: ok is a ✓ in a circle, warn
  is ! in a triangle, alarm is × in an octagon. The verdict word always appears, and each
  dimension chip shows its glyph and its label (VEL / ROM / TEMPO). The row's left border repeats
  the verdict tone as a secondary cue. With no verdict the border is dashed.
- **Colour is reserved for the verdict.** Working-set bars are a neutral blue-grey; only the
  set the verdict reads is filled in the tone colour and marked ◆. Next-time is **neutral ink**: a
  back-off isn't a failure, and colouring it red would argue with the verdict.
- **Contrast:** every ink token is at least 4.5:1 on every surface it sits on. Measured values are in
  `tokens.css`; the lowest text pair is muted on raised at 5.6:1. Warm-up bars are 3.7:1 (non-text, ≥ 3:1).
  The light theme was measured the same way, with all pairs at or above 5.1:1.
- **Grid:** 270 px verdict | flexible evidence | 430 px next time. Every row gives the set strip the
  same width (the longest exercise's set count), so the fatigue/strength facts line up down the page.

### Verdict vs progression: making the disagreement legible

They measure different things, so the page **names what each one read, in parallel words**:

- under the verdict: "◆ Reads set #2, the worst working set". The ◆ is also on that bar and in
  the table.
- under next time: "READS REPS VS 12–15: [5↓] [5↓]". Each loaded working set is a chip with its
  rep count and ↓ / ✓ / ↑ against the target.

When they point opposite ways (ok verdict + back-off, or warn/alarm verdict + add), a blue
⇄ note says so in plain words: *"Verdict and plan differ: the bar moved well, but the reps fell short of
target, so the load comes down."* The note uses the neutral notice colour, not a tone colour, because
it explains rather than warns. A "Slowing" verdict next to a hold, or "Grinding" next to a back-off, is
agreement, so no note appears.

### Honest absence

| Gap | How it reads |
|---|---|
| Set with no velocity telemetry | hatched, dashed-outline empty bar to full height, labelled *no data* in italics; "no data" in the table; the fatigue fact adds "· 1 set without speed data" |
| `volumeLbs: null` | exercise: "no load recorded"; session volume: "excl. 2 unloaded sets (damper 6)", so it's never a 0 |
| Band set (weight null) | load shows "band"; next-time chips add "+1 with no load, not scored", matching the server's "1/1 sets" |
| RIR / RPE | header stat "Effort (RIR): *withheld* until fitted to your own sets", repeated in the table footnote. No widget, no zero |
| `endedAt: null` | title becomes "Session not ended", the time line shows "started 18:10 · last set 18:24 · no end time", and a dashed blue banner says the numbers cover sets so far and may change. Duration isn't invented |
| No verdict | "No verdict" in grey at a smaller size, with the reason (no working sets / no speed data on working sets) |
| No progression | "No recommendation" plus the server's `progressionNote` |
| All-time records / cross-session trend | not shown. e1RM is labelled "from this session only", and there are no PR stars |

## 4. Wall vs phone

The phone layout isn't the wall layout squeezed. The phone is held in the hand after the session,
often while walking away from the machine, so the question becomes "what do I write down for next
time?".

- **At-a-glance list first** (phone only, sessions with 2+ exercises): one row per exercise with
  its verdict glyph and word, the next load and the change. On fixture 2 the whole session's answer fits
  in the first screen.
- **Then one card per exercise**, stacked in the brief's order: verdict → evidence (the strip
  fits five sets at 390 px; facts in a 2-column grid) → next time (chip wraps under the load) →
  "All N sets" list (open by default; native `<details>` collapses it). Each glance row links to its card.
- **Totals move into the card on phone** (sets, reps, top load, volume, best rep). On the wall they
  live in the record table's group header to keep rows short.
- Header stats go into a 4-across grid, with the RIR line full width under it.
- Breakpoint: 760 px. Display sizes step down (44 → 34 px verdict, 36 → 30 px load) in `tokens.css`.

## 5. kg mode

- All loads, volumes, e1RM and targets convert at 0.4536 and round to whole kg.
- Non-weight `loadLabel`s ("damper 6", "band", "iso") are shown verbatim in both modes.
- **The change chip matches the numbers on screen**: 100 lb → 105 lb displays as 45 → 48 kg,
  so the chip reads "Add 3 kg", not the physical 2.3 kg. Otherwise the lifter sees "+2" next to two
  numbers 3 apart.
- **Server prose stays verbatim and gets a small "server text in lb" tag.** This covers `progression.reasoning`,
  `loadDrift.reason` and `expectedRepRange.basis`. I rejected regex-rewriting "120 lb" inside text we don't
  own: it breaks on ranges ("115-125 lb") and on the step size, and a mistranslated sentence is
  worse than an honestly labelled one.
- **Payload fix (ask 1 below):** ship a structured reason, not just a sentence.

## 6. Every contract field

| Field | Where it appears | Notes |
|---|---|---|
| `session.id` | compared with `progression.basedOnSessionId` | not displayed |
| `session.startedAt` | header date and start time; duration | |
| `session.endedAt` | header end time and duration; null → open-session title, time line and banner | |
| `session.exerciseId`, `session.exerciseName` | **dropped** | Looks like the session's current or last exercise (Face Pull in fixture 2, null in 3). It repeats `exercises[]` and means nothing once the session is over |
| `exercises[]` order | row order | "order first trained" |
| `exerciseId` | React key; null → Unattributed styling | |
| `name` | row title; "Unattributed" is italic grey with "These sets named no exercise." | |
| `setCount`, `workingSetCount` | record group header (wall), totals (phone); header sums | |
| `totalReps` | same; header sum | |
| `volumeLbs` | same; header sum excludes nulls and says so | null shows "no load recorded", never 0 |
| `topWeightLbs` | "top 120 lb" in totals | null shows "no load recorded" |
| `bestRepVelocity` | "best 0.62 m/s" in totals | |
| `maxVelocityLossPct` | fatigue fact ("worst N%" when it isn't the last set) | |
| `verdict.state`, `.tone` | verdict word, glyph, border, verdict-set bar fill | |
| `verdict.dimensions.*` | VEL / ROM / TEMPO chips, each with its own glyph | |
| `verdictSetIndex` | "◆ Reads set #N", ◆ on the strip column and table row | |
| `progression.delta` | action chip ▲ Add / = Hold / ▼ Back off; glance list | |
| `progression.reasoning` | "PLAN" line, verbatim | lb tag in kg mode |
| `progression.basedOnSessionId` | only shown if it differs from `session.id` | always equal in the fixtures |
| `progression.targetSets`, `targetRepsLow/High` | "3 × 12–15"; "reads reps vs 12–15" chips | |
| `progression.targetWeightLbs` | the 36 px next load | |
| `progressionNote` | under "No recommendation" | |
| `loadDrift.*` | drift flag in next time: "▽ Load drift: easier than planned, 70% → 58% of max (−12 pts)" + `reason` | arrow shape and word carry direction |
| `sets[].index` | strip "#N", table, rest computation | |
| `sets[].id` | React key | |
| `sets[].startedAt`, `endedAt` | table "Started · length", "Rest before" (derived) | |
| `sets[].weightLbs` | Epley e1RM, kg conversion, scoring eligibility | |
| `sets[].loadLabel` | strip and table load (lb mode; verbatim for non-weight in kg) | |
| `sets[].repCount` | strip (28 px), table, rep chips | |
| `sets[].setPurpose` | strip: narrower dim bar plus "warm" / "tech" / "probe"; table purpose column | |
| `sets[].velocityLossPct` | strip bar height and label; table | null shows hatched "no data" |
| `sets[].bestRepVelocity` | table "Best rep" | |
| `sets[].expectedRepRange` | "Your usual here: 9–13 reps (7 past sets)" fact; table "Usual reps" column; `basis` in the record group header | `median` **dropped**: the brief says always a range, never a point, and a median invites point-reading |

Derived on the client: Epley e1RM per loaded working set; first → last trends for VL and e1RM;
rest between sets; rep-target scoring; verdict/plan agreement; session sums.

## 7. Payload asks

The page stands without any of these. Ranked:

1. **Structured progression reason** (`{ rule: 'hit-top' | 'in-range' | 'missed-low', setsCounted,
   setsMeeting, repsThreshold }` alongside `reasoning`, and the same for `loadDrift`'s numbers,
   which are already structured). It fixes kg mode properly, lets the "reads reps vs target" chips use the
   server's own count instead of my mirror of it (I infer "unloaded sets aren't scored" from "1/1"), and
   replaces nothing.
2. **Last session's working sets for this exercise** (just `{ date, sets: [{ weightLbs, loadLabel, repCount }] }`).
   "How did it go?" is relative: 10, 11, 12 at 120 lb means something different if last week was
   9, 9, 8. It would add one muted line under the facts: "Last time 120 lb × 9, 9, 8". It replaces nothing.
3. **An explicit `inProgram: boolean` per exercise.** Today "outside the program" is only knowable by
   reading `progressionNote` prose. A flag would allow a small "not in program" tag on the row title.

Considered and **not** asked: per-rep velocity/ROM/tempo (the verdict already summarises it;
it belongs on a drill-down, not a wall), e1RM history (a cross-session chart competes with the
verdict for the top slot; it belongs on Goals), weekly sets per muscle and goal progress (other pages).

## 8. Chrome ideas (not built)

- Status bar: when the open session is the one on screen, show "Session open, end it?" there
  instead of on this page, since ending a session is a device action.
- Rail: a badge on Review when an un-viewed session-complete page exists.
- On the wall, an idle timeout that cycles between this page and Live would keep the verdict
  on screen while the lifter cools down.

## 9. Open questions

- `bestRepVelocity` at exercise level seems to cover working sets only (RDL is 0.62, not the 0.78
  warm-up), except when there are none (Lateral Raise is 0.90 from technique sets). Is that intended?
- Is `session.exerciseName` the last exercise trained or the "current" exercise in an open
  session? I dropped it either way.
- Does progression really skip working sets with no load (band) when counting? The "1/1" in
  fixture 3 suggests yes, and I mirrored it.
- Should a technique-only exercise show its VL at all? I show it in the strip (it's the record)
  but say "no working sets" for fatigue, since only working sets count.
- Timestamps render in the viewer's local time zone; screenshots are pinned to UTC.
