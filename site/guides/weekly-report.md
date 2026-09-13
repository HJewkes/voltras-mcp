# The weekly report

By the end of this you'll know what each section of [`report.weekly`](/reference/report)
means for a coach reading it, how to call it, and how it feeds the accountability protocol.

This assumes the [coach-report guide](/guides/coach-report) already — a weekly report is
built from the same per-session results that guide covers, rolled up over a date range.

## What it is

`report.weekly` is a coach-readable rollup over a date range — the last 7 days by default —
in markdown or JSON. Both formats render from the same underlying data, so a number in one
never disagrees with the same number in the other. It's read-only: no network call, and it
writes nothing.

Every example below is real output from the test suite's fixture
(`src/tools/__tests__/report-weekly-tools.test.ts`), not an invented sample.

## The header

```
# Weekly Report
Range: 2026-09-07T00:00:00.000Z to 2026-09-11T00:00:00.000Z

Sessions completed: 2
Last 28 days: 2 sessions completed
Adherence: planned 2 / done 1 (trend: no-prior-data)
```

- **Lifter** appears in the title (`# Weekly Report - <name>`) when the report was scoped
  to one; a report with no `lifter` input covers the local owner and the line is omitted.
- **Range** is the `from`/`to` window the report was asked for.
- **Sessions completed** counts ended sessions inside that range.
- **Last 28 days** is a separate, always-rolling count of ended sessions in the 28 days
  before the range's end — deliberately **not a streak**. It doesn't care whether those
  sessions were on consecutive days or bunched at the end of the window; it exists so a
  coach can tell "did they train enough this month" apart from "did they train this week"
  without the two questions bleeding into each other.
- **Adherence** only appears when at least one session in range was attached to a planned
  workout template. It reads `planned N / done M`: `N` is every template belonging to the
  week(s) those sessions touched, and `M` is how many of those templates got an ended
  session attached — regardless of which calendar day that session actually landed on. A
  session run on a named fallback day still counts as done; this model was never checking
  the exact day in the first place.

  The `trend` next to it is a **direction, not a count**: `improving`, `declining`,
  `steady`, or `no-prior-data`. It compares this range's done/planned ratio against the
  same-length range immediately before it. Read it as "is adherence moving the right way",
  not as a number you can add up — two ranges with very different session counts can still
  report the same trend, and that's by design. `no-prior-data` means there was nothing to
  compare against (a new plan, or no attached session in the previous range), not that
  adherence is bad.

## Per-session blocks

```
## Sessions

### 2026-09-08 - Upper A
seated-row
170 lb x 2
170 lb x 2
170 lb x 2
```

One block per ended session in range, in date order. Each names the workout template it
was attached to (when any), then repeats the same per-exercise result strings
[`report.session_results`](/reference/report) would produce for that session verbatim — so
reading the weekly report and reading a single session's results never disagree about the
same set. When the RIR-estimate baseline gate has enough history for an exercise, an RIR
line follows its result; when it doesn't, the line is simply absent rather than showing a
guess.

That RIR line is a per-rep estimate (`vbt.rir`), not the same claim as the velocity target
[`rir_velocity.target`](/reference/rir_velocity) reads back from a lifter's own fitted
curve. Neither this report nor anything else in this server turns a velocity-loss
percentage straight into a reps-in-reserve number: Jukic, Prnjak, McGuigan & Helms (_Eur J
Appl Physiol_, 2023) found the agreement between velocity loss and percentage of max reps
completed unacceptable at every load tested, with errors over 10%. Read the "velocity-loss
holds" flag below as a volume-control dial — the set stopped at a threshold — never as a
proximity-to-failure estimate.

## Progression suggestions

This section only appears when a session in range trained an exercise that's part of the
active program. One line per exercise, using the same heuristic
[`plan.suggest_progression`](/reference/plan) uses elsewhere, in the shape:

`<exercise>: +5 lb (suggestion for the coach, not applied) - gates: technique=..., effort=..., setsUnlocked=... - tier: ...`

Every line is explicitly labelled **"suggestion for the coach, not applied"** — nothing in
this report changes a prescription. It's the coach's call whether to act on it, and the
`gates` and `tier` after it are the same inputs the heuristic weighed, there for a coach
who wants to check its work rather than take the number on faith.

## Flags

```
## Flags
- setting_coerced: not persisted; live-only signal
- weight_implied_mismatch: 1 set(s) (mismatch-1)
- inactivity_timeout with reps recorded: 1 set(s) (timeout-1)
- velocity-loss holds: 1 set(s) (hold-1)
```

Three flags point at sets worth a second look:

- **weight_implied_mismatch** — the load a header claimed doesn't match what the recorded
  force implies.
- **inactivity_timeout with reps recorded** — the set was closed by the idle timeout, but
  reps were still recorded on it, so it's worth confirming those reps are real.
- **velocity-loss holds** — the set was held at the VL30 autoregulation stop point.

**`setting_coerced` never lists any sets, on any report.** It's a live-only comparison
between what a tool call asked the device for and what the device echoed back
mid-session — there's no persisted record of it once a session ends, so a report built
afterward has nothing to read back. The line above is the report saying so plainly rather
than silently omitting a flag a coach might otherwise assume was checked and found clean.

## The check-in section

```
## Check-in
- 2026-09-08T08:00:00.000Z (rpe): felt heavy
- 2026-09-09T08:00:00.000Z (rpe): felt heavy
Themes:
- felt heavy (2)
```

Built from recorded self-reports for the range. Repeated exact-text entries (case- and
whitespace-insensitive) roll up into a `Themes` count, so a phrase three lifters — or the
same lifter three times — used verbatim stands out instead of scrolling past as three
separate lines. Self-reports tagged against the "this muscle felt off" question code are
also checked for a muscle group named more than once; a repeat there is worth asking about
even if the lifter didn't bring it up again unprompted.

When no self-reports exist for the range at all, the section falls back to the `notes`
input as a plain lifter note instead — and if neither exists, the whole section is omitted.

## Calling it

```
report.weekly({ format: "json" })
report.weekly({ from: "2026-09-01T00:00:00.000Z", to: "2026-09-08T00:00:00.000Z" })
```

- `format` — `"markdown"` (default) or `"json"`. JSON returns the same data tree the
  markdown is rendered from, for a caller that wants to compute over it rather than read it.
- `from` / `to` — ISO-8601 bounds on the range. `to` defaults to now; `from` defaults to
  7 days before `to`.
- `lifter` — scope the report to one lifter's sessions. Omitted means the local owner.
- `notes` — a fallback check-in note, used only when no self-reports exist in range.

## Feeding the accountability protocol

[`accountability.state`](/reference/accountability) reads this same adherence trend —
never a raw planned/done count — to decide whether its Thursday touch sends a message or
stays silent: a flat or worsening trend is one of the conditions that can trigger a send,
while an improving trend is a reason to stay quiet. That's a deliberate choice — the
escalation ladder is keyed to which direction adherence is moving, and a raw count would
let one bad week on an otherwise strong plan misread as decline.

## What to read next

- The [`report.*` reference](/reference/report) for the tool's full schema.
- The [coach-report guide](/guides/coach-report) for what a single session's result
  strings mean.
- The [`accountability.*` reference](/reference/accountability) for the protocol state
  this trend feeds into.
