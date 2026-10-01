---
title: Import a TrueCoach week
description: Pull a coach's assigned TrueCoach workouts into the lifter's local plan with truecoach.import_week, read-only.
diataxis: how-to
audience: [coach, lifter]
status: available
sources:
  - README.md
  - src/tools/truecoach-tools.ts
  - src/schemas/truecoach.ts
  - src/config.ts
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Import a TrueCoach week

`truecoach.import_week` reads the workouts a coach assigned in TrueCoach for a date range and
writes them into the lifter's local plan. Claude then runs sessions against that plan. The
tool never writes to TrueCoach, and it runs only when called (`README.md`, "TrueCoach
(read-only pull)").

Read [the terms-of-service passage](/coaches/consent-and-data-loop#truecoach-import-read-only-and-the-coach-has-not-consented)
before the first import. TrueCoach publishes no public developer API, and the lifter's
account is the one at risk (`README.md`, "Terms of service — read this before using it").

## For the coach: write instructions the parser can read

The import reads sets, reps, load and rest from your instruction text with a deliberately
narrow parser. These forms parse, quoted from `README.md`:

```
3 x 8-10 @ 135lb, rest 90s
50lbs x AMRAP x 4 sets
4 sets of 12
```

Anything it cannot read is left out of the target, and your whole instruction is kept word
for word in the plan's `notes` either way (`README.md`, "What it does").

## For the lifter: set up credentials once

Set these in the environment the server starts with, for example in `.launch.env`
(`README.md`, "`.launch.env`"). The block is verbatim from `README.md`, "Setup":

```bash
# Put the password in the macOS keychain once:
security add-generic-password -a "$USER" -s truecoach -w

export VMCP_TRUECOACH_USERNAME='you@example.com'
export VMCP_TRUECOACH_PASSWORD_CMD='security find-generic-password -a "$USER" -s truecoach -w'
```

With no credentials the tool returns `NOT_CONFIGURED` and makes no network call. It never
prompts, and it never writes the token or the password to a log line or an error message
(`README.md`, "Setup").

## Import a week

1. **Rehearse.** Ask Claude for a dry run of this week's TrueCoach import. The tool maps
   the workouts and reports the tree without writing anything (`dryRun: true`,
   `src/schemas/truecoach.ts`). With no dates it covers the current ISO week.
2. **Resolve unmatched names.** An exercise name must match the catalog exactly, ignoring
   case and punctuation. A near match is never accepted, because a wrong match would credit
   the lift to a movement the coach never prescribed. Unmatched names come back in
   `unmapped` with up to three candidates. Pass
   `mapping: { "<TrueCoach name>": "<catalog exercise id>" }` on the next run to resolve
   them (`README.md`, "What it does").
3. **Import.** Run it again without `dryRun`. The workouts land in a block named
   "TrueCoach import" in the program you name with `programId`, else the lifter's most recent
   non-archived program. The block gets one week per ISO week in the range, empty weeks
   included, and one template per workout (`src/tools/truecoach-tools.ts:11-15`).
4. **Train.** Attach the imported workout to the session as in
   [Running a planned session](/guides/planned-session).

## Re-importing after the coach edits a week

Run the same range again. Every row carries its TrueCoach id, so a second run updates rows
in place and never duplicates them (`README.md`, "What it does"). Raw responses are cached
for six hours; pass `refresh: true` to fetch the coach's latest edits sooner (`README.md`,
"Setup").

## When the import refuses

Each of these refuses the import before writing anything (`src/tools/truecoach-tools.ts`):

- `BLOCK_STARTED`: the earliest imported week falls before a block that has already
  started. A started block keeps its dates.
- `SCHEDULE_OVERLAP`: the imported weeks would overlap another dated block, which the
  error names.
- `INVALID_INPUT`: a row breaks the shared prescription rules, for example an inverted rep
  range. Its `field` names the input to fix.

## Related

- [`truecoach.*` reference](/reference/truecoach) for the full parameter list.
- [Onboard a client](/coaches/onboard-a-client) for where the import fits in the loop.
