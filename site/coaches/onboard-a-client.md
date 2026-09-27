---
title: Onboard a client
description: Paired steps for a coach and a lifter, from installing voltras-mcp to the first session report reaching the coach.
diataxis: how-to
audience: [coach, lifter]
status: available
sources:
  - README.md
  - src/tools/report-tools.ts
  - src/tools/truecoach-tools.ts
lastVerified: 2026-09-27
---

# Onboard a client

Each step is marked **[Coach]** or **[Lifter]**. The lifter does everything on their own
machine; the coach never installs anything. Read [the onboarding model](/coaches/onboarding-model)
first if you have not.

## 1. Agree how results travel

**[Coach]** Tell the lifter where you want results: in a message, or in the TrueCoach
result box. The same text fits both, because it follows TrueCoach's free-text "Result"
idiom (`src/tools/report-tools.ts`, [Read a session report](/coaches/read-a-session-report)).

**[Lifter]** Read [Consent and the data loop](/coaches/consent-and-data-loop), so you know
what you would be sending. If you ever plan to post results into TrueCoach automatically,
tell your coach before the first real submit (`README.md`, GATE 1).

## 2. Install and run a first session

**[Lifter]** Install voltras-mcp and register it with Claude Code by following
[Install](/start/install). Then follow [Your first session](/start/first-session).
It works with a Voltra or, for a rehearsal, with the mock adapter. Mock-adapter sets never
appear in a report (`README.md`, "Coach results and the outbox").

## 3. Give the lifter a plan

**[Coach]** If you use TrueCoach, assign the week's workouts as you normally do.

**[Lifter]** Ask Claude to import that week. Claude calls `truecoach.import_week`, which
reads your assigned workouts and writes them into the local plan. It never writes to
TrueCoach (`src/tools/truecoach-tools.ts`). The setup is in
[Import a TrueCoach week](/coaches/import-a-truecoach-week).

Without TrueCoach, the lifter builds the plan with Claude instead; see
[Running a planned session](/guides/planned-session).

## 4. Train against the plan

**[Lifter]** Run the session with the planned workout attached, as in
[Running a planned session](/guides/planned-session). The attached plan is what lets the
report show a `missed:` line for a working set below the rep target (`README.md`, "Coach
results and the outbox"). End the session when you finish: a report needs an ended session
(`src/tools/report-tools.ts`).

## 5. Send the first report

**[Lifter]** Ask Claude for the session's results. Claude calls `report.session_results` and
returns one result string per exercise. Send that text to your coach the way you agreed in
step 1.

To keep a copy of every session without asking, set `VMCP_TRUECOACH_OUTBOX=on`. Each
`session.end` then writes the same text to
`~/.voltras/truecoach-outbox/pending/<sessionId>.json`, ready to paste. Nothing uploads that
file (`README.md`, "The outbox").

## 6. Read it

**[Coach]** Read the result with [Read a session report](/coaches/read-a-session-report).

**[Lifter]** At the end of the week, ask Claude for the weekly report (`report.weekly`) and
send it too.

**[Coach]** Read it with [Read the weekly report](/coaches/read-the-weekly-report). Its
progression lines are suggestions for you, and nothing in the report changes a
prescription. Adjust next week in TrueCoach, and the loop starts again at step 3.
