# Running a planned session

By the end of this you will have built (or imported) a training plan, attached it to a
live session, run the session against its prescription, and closed out the workout
template it came from — plus know what to expect if you land on a block boundary.

This assumes the [first-session guide](/guides/first-session) already, since a planned
session is the same `session.*`/`set.*` lifecycle with a prescription layered on top of
it.

## The plan hierarchy

Plans nest: programs → blocks (mesocycles) → weeks → workout templates → planned
exercises. Each level under [`plan.*`](/reference/plan) takes its parent's id —
[`plan.block.create`](/reference/plan) takes `programId`, `plan.week.create` takes
`blockId`, and so on down to [`plan.exercise.create`](/reference/plan), which takes
`workoutTemplateId` and is the leaf: the actual prescribed exercise, sets, reps, and load
for one slot in one template.

You can build a plan this way from scratch, or pull one in — see
[TrueCoach (read-only pull)](https://github.com/HJewkes/voltras-mcp/blob/main/README.md#truecoach-read-only-pull)
in the README if you already track plans there.

`plan.exercise.create` also takes an optional `targetTempo` coach override — a
`{ ecc, pauseBottom, con, pauseTop }` tuple in seconds — that wins over the exercise's or
movement pattern's default tempo in the live prescription (`src/tools/plan-tools.ts`,
VW-46).

## Attaching the plan to a live session

[`plan.attach_to_session`](/reference/plan) links a real session to a plan entity —
either one `plannedExerciseId` or a whole `workoutTemplateId` (exactly one of the two).
It doesn't require the session to have been started from the plan; you connect what's
actually happening to what was prescribed after the fact just as easily as before
(`src/tools/plan-tools.ts`).

Attach at the template level for a session that will move through several exercises. The
dashboard (and any reader of the same state) resolves the prescription for whichever
exercise the session is currently pinned to by matching it against that template's
planned-exercise rows — so one `plan.attach_to_session` call covers the whole session,
not just the exercise you started on
(`src/dashboard/read-models/session-plan.ts`).

To move from one planned exercise to the next inside that same session, use
[`session.set_exercise`](/reference/session) rather than ending and restarting the
session — it exists specifically for "a multi-exercise session moving to its next
movement" (`src/tools/session-tools.ts`).

## Running the session

From here it's the [first-session](/guides/first-session) flow — `set.start` /
`set.end` per set — with the prescription visible on the
[dashboard](/guides/#mid-set-with-a-plan-attached) alongside what the set is actually
doing: target rep band and load next to per-rep velocity, fatigue verdict, and each rep's
tempo. `set.start`'s `setPurpose` (`working` / `warmup` / `probe` / `technique`) still
applies the same way it does off-plan.

If you want a warm-up ramp before the first working set, `plan.warmup_ramp` proposes one
for a given exercise and working load — it's read-only, writes nothing, and never starts
a set itself; you start each proposed row yourself with
`set.start { setPurpose: "warmup" }`, and you're free to skip or shorten it if the lifter
says they're already warm (see [the reference](/reference/plan) for what the ramp
proposes and where it's cited from — the numbers there are RP's, not this server's).

## Progression suggestions are advisory

[`plan.suggest_progression`](/reference/plan) proposes a load/weight-delta (and,
above roughly a 15-rep prescription, a rep delta instead) for the next occurrence of an
exercise, based on the most recently completed session for it. It's a suggestion, not a
write to the plan — nothing about the planned exercise changes because you asked for one
(`src/tools/plan-tools.ts`). The same advisory posture applies to
[`profile.get_starting_prescription`](/reference/profile): it reads the athlete's tier
signal and self-report into a conservative starting point and applies nothing on its own.

## Completing the workout and what `blockBoundary` means

[`plan.complete_workout`](/reference/plan) marks a workout template completed, optionally
linking the real session that completed it. [`plan.next_workout`](/reference/plan)
returns the next un-completed template for a program. Both return a `blockBoundary`
field, `null` in the ordinary case — it's only non-null right at the edge of a block:
`plan.next_workout` names it when the template it's returning is the first of a new
block, and `plan.complete_workout` names it when the template just completed was the
last of the last week in its block. Either way it carries the finished block, the
adjacent block, the goal currently on file, and an advisory prompt to keep or restate
that goal — the goal itself is never written by either tool, and nothing here is applied
automatically (`src/tools/plan-tools.ts`, VMCP-06.06 / B48).

## What to read next

- [The first-session guide](/guides/first-session) for the base `session.*`/`set.*`
  lifecycle, auto-arm, and the header-weight rule.
- The [dashboard walkthrough](/guides/) for what a planned session's prescription looks
  like rendered live, and the "Building the plan behind it" section for the plan builder
  view.
- The [`plan.*` reference](/reference/plan) for full schemas on every tool named above.
