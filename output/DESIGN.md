# Session complete (Review): blind redesign, round 1

Built from the brief and `input/session-summary-current.png` only. No product source was read.

## 1. Critique of the current view

The capture is scrolled: its top (the verdict and the e1RM chart, judging by the "Actual / Projected / ★ PR" legend fragment) is cut off. I critiqued what is visible and noted where I had to guess.

1. **Nothing is readable at 3 m.** The largest text on screen is the 14–15 px "5 × 140 lb". Section labels are about 11 px, threshold labels about 8 px monospace. From across a room the page is a grey rectangle with one coloured stripe.
2. **The page answers the questions in the wrong order and at the wrong sizes.** The velocity-loss gauge, which is supporting evidence, gets the full width and the strongest colour. The next-session recommendation, the one thing the lifter acts on, is a 13 px label in the middle of a 1300 px row.
3. **Red is used for advice.** "−5 lb" is rendered in alarm red. Backing off 5 lb is a normal coaching instruction, not a failure. Meanwhile "+0% e1RM" is green, which reads as praise for no change.
4. **The gauge is a single point on a rainbow.** A four-hue gradient bar (green, amber, orange, red) with one tick shows only the worst set. It hides the shape of fatigue across sets, which is the actual evidence. Hue is the only band carrier apart from tiny labels, so it fails for red-green colour-blind readers.
5. **The verdict and the recommendation appear to contradict each other without explanation.** The verdict (cut off, but the brief says Good) sits beside "2/2 sets missed 12 reps; back off 5 lb". The page never says that the verdict is about bar speed and form, while progression is about the rep target. A lifter sees "Good" and "back off" and can't tell which to believe.
6. **The set list is a sentence, not a table.** "5 × 140 lb … loss 12% … best 0.5" has no column headers, no units on velocity, and huge gaps that break the eye's path across a row. Numbers are not right-aligned, so they can't be compared down a column.
7. **Dead space.** About 60% of the 1440×900 frame is empty background under the card, while the content above it is cramped.
8. **Absences are invisible.** There is no sign of RIR being deliberately withheld, and no treatment for missing data.

## 2. Information architecture

The brief's four questions map onto **one row per exercise, read left to right**, then the raw record below:

```
┌ header: date · duration · exercises · working sets · volume · RIR (withheld) ┐
├ exercise row ───────────────────────────────────────────────────────────────┤
│ 1 VERDICT          │ 2 EVIDENCE                        │ 3 NEXT TIME        │
│ name               │ velocity loss per set (bars,      │ Add / Hold / Back  │
│ ◉ Good  (40 px)    │ VL10/20/30 refs, verdict set      │ off 5 lb (34 px)   │
│ speed·range·tempo  │ highlighted)  │ est. max, session │ target load × reps │
│ hardest set #n     │               │ best, first→last  │ reasoning, drift   │
├ … one row per exercise, in training order …                                 ┤
└ 4 EVERY SET: per-exercise tables, all sets, aligned numeric columns ─────────┘
```

Why rows rather than four page-wide sections (all verdicts, then all evidence, then all recommendations)?

- **Every question is about an exercise.** "How did the row go, why, and what do I do next time?" is one thought. Splitting it across sections makes the reader hold the exercise name in their head while scanning down.
- **Left-to-right is the priority order.** The eye lands on the verdict column first, then the evidence, then the recommendation, so the brief's ranking holds within each row. Down the page, the verdict column on its own is a scannable summary of the whole session.
- **It fits the wall.** A typical four-exercise session fits in 1440×900 with no scrolling (see `full-wall-dark.png`). The raw record is the only thing below the fold, which matches its rank of 4.

The **header** holds session facts plus one deliberately empty slot, **Reps in reserve: 🔒 Calibrating, held back until fitted to you**. It gets a lock icon, a dashed separator and a sentence of explanation, so it can't be mistaken for zero, a load failure or a missing widget. It appears once per page, not once per exercise, because it's a property of the lifter's model, not of a set.

## 3. Hierarchy, layout, typography

**Three reading distances, three type layers** (Inter, tabular figures for every number):

| Layer | Distance | Elements | Size |
|---|---|---|---|
| Glance | 3 m | verdict word, next-time headline | 40 / 34 px, 750 weight |
| Read | 1–2 m | exercise name, target load × reps, est. max, header stats | 20–28 px |
| Inspect | arm's length | reasoning, chart labels, set table | 14–17 px |

The minimum is 11 px, used only for chart ticks and tags. The current view goes down to about 8 px.

**Verdict.** Each verdict has a colour, a word and a shape: Good is a green circle with a check, Slowing is an amber triangle, Grinding and Form breaking down are a red octagon with ✕. The three dimension chips (Speed, Range, Tempo) use the same three shapes, so the worst dimension can be spotted in greyscale. The row also gets a tone edge (a 6 px stripe on the wall, a top bar on the phone), so the session's shape reads from across the room. Under the verdict is "Hardest set #5 · 23% speed loss". This states that the verdict reads the worst set, which the contract specifies but the old view only implied.

**Evidence: fatigue chart.** One bar per set in session order, with height showing velocity loss. Dashed reference lines at VL10, VL20 and VL30 are labelled on a left gutter. All rows share one y-scale (0–40%, or more if needed), so a 34% bar on chest press is visibly taller than a 13% bar on row. Colour is reserved for the one bar the verdict reads; every other working set is neutral grey. Warm-up, probe and technique sets are dashed outlines with a text tag under the tick ("warm", "probe", "tech"). Sets without telemetry get an explicit dotted "no data" chip at the baseline, never a zero-height bar. Every bar has a printed value, so colour never carries the number.

**Evidence: strength.** Est. max (Epley, working sets with a load) shows the **session best**, labelled "session best", never "PR". Below it are the set it came from and the first-to-last change. With one working set it says "one working set" instead of a meaningless ±0%. When no set had a load (damper mode) it says "needs a recorded load".

**Next time.** The headline is the instruction: "Add 5 lb", "Hold", "Back off 5 lb", using the same ↑ = ↓ glyph language in a neutral accent colour. Advice is never alarm-coloured. Below it are the target ("105 lb · 3 × 12–15") and the server's reasoning sentence. When progression is null the headline is a muted "No recommendation" with the progressionNote. **Load drift** is a one-line flag here ("Load got easier: 70% → 58% of max") because it affects what to load next time. The full reason sentence is in the tooltip and is repeated above that exercise's set table.

**Every set.** One table per exercise, with columns Set · Type · Load · Reps · Usual reps · Vel. loss · Best speed · Est. max · Rest. Numbers are right-aligned with tabular figures. Non-working sets are dimmed. Load falls back to the truthful label in italics ("*damper 6*"). The verdict set carries a VERDICT tag and the best e1RM a BEST tag. **Usual reps** is a small range strip: a band from expectedLow to expectedHigh with a dot at the actual count, and the dot becomes a diamond when below the range. It's always shown as a range, never a point, as the contract demands. **Rest** is derived from the previous set's `endedAt` to this set's `startedAt`, so no payload addition is needed for it. Missing values say what is missing ("no data", "no history", "no load").

**Header absences.** Volume is the sum of non-null `volumeLbs`, with "+ 2 sets with no load" beneath, so damper sets are acknowledged, not counted as 0. If no set at all has a load it says "not recorded". A null `endedAt` shows "≥ 27 min" with a warning glyph and "no end time; to last set": it's a lower bound computed from the last set, never a fabricated duration.

**Colour and contrast** (computed, WCAG 2.1, against the card surface):

| token | dark (#171a1d) | light (#fff) |
|---|---|---|
| secondary ink | 10.8 | 10.0 |
| tertiary ink (labels) | 6.9 | 5.9 |
| ok / warn / alarm text | 7.7 / 9.5 / 6.3 | 5.5 / 5.6 / 5.5 |
| neutral bar (graphic) | 3.5 | 3.0 |

Every tone has a glyph and a word, so no meaning is carried by hue alone.

## 4. Wall vs phone

| | Wall (1440×900, 2–3 m) | Phone (390×844, in hand) |
|---|---|---|
| Nav | 88 px left rail | bottom tab bar |
| Header | one line: title, units toggle, stats right-aligned | title, then a compact 3–4 column stat grid; duration flag and RIR on their own lines |
| Exercise | 3-column row: verdict, evidence, next | stacked card in the same order; tone bar on top |
| Fold | whole session (4 exercises) visible without scrolling | first verdict and its evidence; scroll per exercise |
| Set table | 9 columns | 2-line rows: Set · Load · Reps · VL · Est. max, then Type and the usual-reps strip. Best speed and rest are dropped. |

## 5. Payload additions I would ask for

1. **Per-rep velocity for the verdict set only** (an array of m/s, about 10–20 numbers per exercise). It shows *why* the verdict is Slowing or Grinding as a rep-by-rep decay sparkline under the hardest-set line. That's the most honest evidence a velocity-based training verdict can show. It would sit in the verdict column; nothing is replaced. Per-rep data for every set is unnecessary on this page.
2. **This exercise's est. 1RM history (last 6–8 sessions).** Strength *within* a session nearly always falls with fatigue (−5%, −10% here), so the current "first → last" number mostly restates the fatigue chart. A short history turns the strength block into a real trend and lets "best" mean something beyond this session. It **replaces** the first→last delta in the strength block.
3. **Unit-neutral progression reasoning.** `reasoning` is a pre-rendered English sentence with "lb" baked in. In kg mode the headline says "Back off 2.3 kg" while the sentence says "back off 5 lb" (see `full-wall-dark-kg.png`). Ask for a reason code plus parameters (`{code: 'missed-reps', hitSets: 2, sets: 2, targetLow: 12, …}`) so the client renders it in the lifter's units. Alternatively, have the server honour the unit preference.
4. **The previous session's line for each exercise** (load × reps per working set). "Last time 120 × 12, 11, 10" next to today's numbers is the comparison a coach reaches for first. It's cheaper than the full history in item 2 and could live in the record header.

Deliberately **not** requested: weekly sets per muscle and goal progress. They answer "how is my training block going", which belongs on Plan or Goals; this page is about one session.

## 6. Open questions

- **Verdict vs progression disagreement.** In the current fixture the verdict is Good (12% speed loss) while progression says back off because reps missed the 12–15 target. Is that intended? The redesign shows both honestly, with a different vocabulary for each ("Hardest set · speed loss" vs the rep reasoning). If it's common, a one-line bridge ("Bar speed was fine; reps fell short of target") would help, but that needs a reason code (see payload item 3).
- **The current-case data looks inconsistent:** 5 reps at 140 lb against a 12–15 target, with "best 0.5" m/s. I reproduced it faithfully.
- **Does a verdict exist for Unattributed sets?** I assumed null. If the server does compute one, the row already handles it.
- **On the phone, should Next time come before Evidence?** I kept the brief's order. A lifter on a phone may only want the instruction.
- **Is VL10 really "fresh"?** The brief calls under 10% fresh and 20% a typical hypertrophy stop. I labelled the lines VL10/20/30 rather than naming bands, to stay neutral.
- **Kg rounding.** Loads convert to the nearest 0.5 kg. The ±5 lb step shows as an exact 2.3 kg. Is there a machine kg increment I should snap to?
