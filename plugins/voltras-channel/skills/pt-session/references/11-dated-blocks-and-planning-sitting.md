# Dated blocks and the planning sitting

**When to read this.** Any tool returned `planning.due` or `planning.prompt`; OR `plan.next_workout` returned `unplanned: true`; OR the user wants to date, move, resize or skip part of a block; OR a week was missed; OR it is time to plan the next block.

Verified 2026-09-19 against voltras-mcp main (#465, #467, #469, #473).

## The model

A program holds blocks. A block holds weeks. A week holds workout templates. Since 2026-09-19 a block can carry **real dates**.

- A block starts on a **local Monday** and runs whole weeks. It ends on the Sunday of its last week.
- Dates live on the block's **schedule**, never on a week. A week's dates come from its place in the block.
- Every change to a block's dates is kept as a row: `planned`, `moved`, `resized`, `week_skipped`, `cleared`. Nothing is overwritten.
- A block that has **started or ended can never move**. The only changes left are a missed week (`plan.week.skip`) or a new length (`plan.block.update`).
- Dated blocks may not overlap, in any active program. Dates must follow the program's order: block 2 cannot start before block 1.
- **Plan blocks ahead of when they start.**

## Which block is in force: `plan.current_block`

Reads only. No parameters. One rule answers "which plan is in force today" for every reader, so no two tools disagree.

| `state`        | Meaning                                           | What is set                                                                          |
| -------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `current`      | A dated block contains today                      | `block`, `calendar`, `week` (`n` of `of`, `isDeload`, dates), maybe `nextBlock`      |
| `upcoming`     | Nothing has started yet; a dated block lies ahead | `nextBlock` (`id`, `name`, `startsOn`). `block` is null                              |
| `gap`          | A dated block has ended and none is current       | `block` is the one that **ended**. Training continues unplanned                      |
| `undated_only` | No block has dates                                | `program` is the newest program with workouts left, else the newest. `block` is null |

Archived programs never count. Once any block is dated, an undated program is never picked.

`planning` rides on the result: `due`, `windowOpensOn`, `reason`, `prompt`.

| Planning is due when                                                              |                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| The current block is in its **final calendar week** and nothing is dated after it | `windowOpensOn` is that week's Monday. A mid-block deload never opens it early |
| The state is `gap` and nothing is planned                                         |                                                                                |
| The state is `undated_only`                                                       | `reason`: "No block has dates yet."                                            |

When `planning.due` is true, `planning.prompt` is set. **Ask the lifter whether to plan now. Create nothing until they answer.** The same `planning` read rides on `plan.next_workout` (field `planning`) and `plan.complete_workout` (inside `current`).

## `plan.next_workout` and its unplanned variant

With `programId`, that program is walked in order. Without it, the plan in force decides: in a `current` block only that block is walked; with no dated block, the newest program with workouts left is walked.

Three shapes come back:

| Shape                                                               | Say                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| A template                                                          | Run it                                                             |
| `{ok: true, completed: true}`                                       | "Every workout in scope is done."                                  |
| `{ok: true, unplanned: true, state, reason, endedBlock, nextBlock}` | "There is no planned workout today. Training continues unplanned." |

The unplanned shape comes in a `gap`, and before the first dated block starts. Then:

- **Never present a workout from the ended block.**
- When `nextBlock` is set, name it and its start date.
- When `nextBlock` is null, offer to plan the next block now.
- An unplanned day is still a training day. Label sets as usual (`04`).

## Dating, moving and resizing

| Goal                                      | Call                                                                                                            | Notes                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date an existing block for the first time | `plan.block.schedule {blockId, startsOn, reason?}`                                                              | Writes a `planned` row. A past Monday of this week is allowed; a start so far back that the block is already over is refused (`BLOCK_WOULD_BE_ENDED`)                 |
| Move a block that has not started         | `plan.block.schedule {blockId, startsOn}`                                                                       | Writes a `moved` row. Setting the date it already has writes nothing                                                                                                  |
| Move it and everything after it           | add `cascade: "later_blocks"`                                                                                   | Every later dated block of the same program moves by the same number of weeks, in one write                                                                           |
| Un-date an upcoming block                 | `plan.block.schedule {blockId, startsOn: null}`                                                                 | Its old dates stay in its history                                                                                                                                     |
| Create a new dated block                  | `plan.block.create {programId, orderIndex, name, weeksCount, startsOn?, scaffoldWeeks?, deloadWeeks?, reason?}` | `scaffoldWeeks: true` builds one empty week row per week. `deloadWeeks` is 1-based. For an existing dated block this tool keeps its dates; use `schedule` or `update` |
| Rename or resize                          | `plan.block.update {blockId, name?, focus?, notes?, weeksCount?, reason?}`                                      | The start never moves here. Refused on an ended block, when a current block would be cut below its current week, and when a longer block would overlap another        |
| Flag a deload, rename a week              | `plan.week.update {weekId, isDeload?, name?, phaseType?}`                                                       | Give at least one field                                                                                                                                               |

Refusals name their cause. Read the message out.

| Code                                     | Meaning                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| `NOT_A_MONDAY`                           | It gives the Mondays either side                                            |
| `INVALID_DATE`                           | Not a calendar date                                                         |
| `SCHEDULE_OVERLAP`                       | Names the block it would overlap. Move that block first, or use the cascade |
| `SCHEDULE_ORDER`                         | Dates must follow the program order                                         |
| `BLOCK_STARTED`, `BLOCK_ENDED`           | It can no longer move. Offer `plan.week.skip` or `plan.block.update`        |
| `BLOCK_WOULD_BE_ENDED`                   | The start is too far back                                                   |
| `USE_BLOCK_SCHEDULE`, `USE_BLOCK_UPDATE` | `plan.block.create` was asked to change a dated block. Use the named tool   |
| `SHORTER_THAN_TRAINED`                   | The resize would cut below work already done                                |

**Goal targets follow their block.** `schedule`, `update` and an extending `skip` return `targetsAffected` (`blockId`, `targetId`, `metric`, `exerciseId`). Read it back: "Your row goal now ends on 11 October." The committed and stretch numbers never change.

## Reading a block back

- `plan.block.calendar {blockId}`: start, end, `state` (`undated`, `upcoming`, `current`, `ended`) and one entry per calendar week: its dates, the plan week run in it (null for an off week added by an extend), `isDeload`, name, whether it was skipped (`hold` or `extend`), `templateCount`, and `sessionDays` (the local dates trained). **A week with `templateCount: 0` has nothing planned; it is not a shorter block.** `history.fact` is one sentence you can say as written.
- `plan.block.schedule_history {blockId}`: every change, oldest first, with who made it (`user`, `coach-default`, `import`).

## A missed week: `plan.week.skip`

**Ask every time. Never infer it from a quiet week.**

Ask: **"You missed week <n>. Hold the calendar, so the block still ends on <date>? Or push the block a week later?"**

| Answer              | `mode`      | Effect                                                                                                                                                             |
| ------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Hold                | `hold`      | The week is marked held. Its plan week is not re-run. The block still ends on its planned date. No goal target moves                                               |
| Push                | `extend`    | An off week is inserted there. That plan week and every later one run a week later. The block ends a week later. `targetsAffected` lists the goals whose end moved |
| They did not choose | omit `mode` | The calendar holds, recorded as the coach's default and not their choice                                                                                           |

```
plan.week.skip {blockId, week: <the calendar week number from plan.block.calendar>, mode, reason?}
```

Read `weekOf` back: it is the Monday the skip resolved to, and it is what was recorded.

Refused: for a block that is not current (`BLOCK_NOT_STARTED`, `BLOCK_UNDATED`, or ended), for a week that has not started (`WEEK_NOT_STARTED`), for a week already skipped (`WEEK_ALREADY_SKIPPED`), for an unknown week (`WEEK_NOT_FOUND`), and for an extend that would run into the next dated block (the error names it).

An extended off week reads like a deload on a goal chart: flat band, no verdict. A held week keeps its band row.

## The planning sitting

Prompted, never automatic.

```
1. plan.current_block          → planning.due: true. ASK: "Your next block is due to be planned. Plan it now?"
                                 On no: stop. Ask again next time it comes back due.
2. plan.block.planning_brief   → reads only
3. Read the brief back (below)
4. Ask about the start date and the length. Then date or create the block.
5. plan.block.calendar         → read the dates and template counts back
6. Relay the priorities re-ask (realignment): keep, restate, or re-architect
7. goal.declare_priorities     → defaults to the block you just dated; read `block` back
8. goal.propose_targets, goal.accept_target  → per `09`
```

### What the brief returns

| Field               | Read it as                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`, `planning` | The same read `plan.current_block` gives                                                                                                                                                                                             |
| `finishing`         | The current block, or the one that ended: its `calendar`, `trained` (`templatesPlanned`, `templatesDone`, `trainingDays`), and `history`. **Null when no block is current or ended**, which includes the very first planning sitting |
| `next`              | The block to plan: `block`, `weekRows`, `calendar`, `history`. The block id is `next.block.id`. Null when there is no block to plan; then create one                                                                                 |
| `suggested`         | `startsOn`, `endsOn`, `weeksCount`, `deloadWeek`, `basis`. A starting point the lifter accepts, changes or declines                                                                                                                  |
| `conflicts`         | Dated blocks the suggested range would overlap, each named with its dates                                                                                                                                                            |
| `realignment`       | The priorities re-ask, as on a block boundary. Null when `finishing` is null                                                                                                                                                         |
| `dietPhase`         | `{phase, weeksInPhase, recompMode}`. **Null means none is declared: raise it** before goals                                                                                                                                          |

How `next` is chosen: the block you name with `forBlockId`; else the block after the finishing one in its program; else the upcoming dated block; else the first block of the program in force with no workout ever done.

How `suggested.startsOn` is chosen: the date the next block already has; else the Monday after the current block ends; else today when today is a Monday (even if a session was already logged today); else the next Monday. `basis` says which, in words. `weeksCount` comes from the next block, else the finishing one. `deloadWeek` is the last week row flagged as a deload.

Say what was trained from `finishing.trained`, as read: "6 of 8 workouts done, on 5 training days." Do not grade it. A missed day is never scored as a failure.

### The priorities re-ask

`realignment` lists each declared priority, how many mesocycles it has been held, the bands it would get for the next block, and `warningsIfChanged`. Offer three answers: **keep, restate, re-architect.** Nothing is written by the brief. An already-accepted target comes back under `skipped`: the re-ask re-proposes and never silently lowers a committed number.

## Block boundaries during a workout

- `plan.complete_workout` returns `current` (the block in force after the write). On the last workout of a block it returns `blockBoundary`: the finished block, the next block or null, the goal on file, `realignment` once priorities exist, and `recompReAsk` (`10`).
- `plan.next_workout` returns `blockBoundary` when its template is the first of a new block, on the same terms.
- Nothing there is written or applied. Relay, ask, record.

## Pitfalls

- **Creating or dating anything before the lifter says yes.**
- **Inferring hold or extend.** Ask.
- **Presenting a workout from an ended block on an unplanned day.**
- **Reading `finishing` when it is null.** Do not make up a summary of an undated block.
- **Declaring goals before the block is dated.** The goal binds to no block and runs a generic 12 weeks.
- **Using `plan.block.create` to move a dated block.** It is refused; use `plan.block.schedule`.
- **Forgetting `targetsAffected`.** A goal's end date moved; say so.
- **An old server.** No `plan.current_block` means none of this exists. Stop (`14`, preflight).

## Cross-refs

- Goal declaration and acceptance: `09-goals-and-weekly-review.md`
- The diet phase the brief reports: `10-bodyweight-diet-phase-rate-advisory.md`
- The plan tree and progression: `03-workout-programming.md`
- The Sunday script and the Block 3 sitting: `14-sittings.md`
