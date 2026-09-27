---
title: The onboarding model
description: Who does what when a coach works with a lifter who trains with voltras-mcp, and how a session becomes a report and a report becomes the next plan.
diataxis: explanation
audience: [coach, lifter]
status: available
sources:
  - CLAUDE.md
  - README.md
  - src/dashboard/server.ts
  - src/tools/report-tools.ts
  - src/tools/truecoach-tools.ts
  - plugins/voltras-channel/skills/pt-session/SKILL.md
lastVerified: 2026-09-27
---

# The onboarding model

Three parties take part: the lifter, Claude as the in-session trainer, and you, the coach.
This page says what each one does and how information moves between them.

## What the tool is, once

voltras-mcp is an MCP server: a small program on the lifter's computer that gives Claude a
set of named tools for driving a Voltra and recording what it measures (`CLAUDE.md`). When
the lifter asks Claude for something, Claude calls a tool. These pages name the tools, such
as `report.weekly`, so that you and the lifter can talk about the same thing. You never call
one yourself.

## Roles

**The lifter** owns the Voltra and the computer it connects to. They install voltras-mcp
and talk to Claude during the workout ([Install and run](/install-and-run)). Every record
lives in one file on their machine, `~/.voltras/vmcp.sqlite` by default (`VMCP_DB_PATH`,
`README.md`).

**Claude** is the trainer inside the session. It connects to the device, sets the load,
records each set and coaches between sets (`plugins/voltras-channel/skills/pt-session/SKILL.md`).
It works only inside the lifter's own session: the server talks to one Claude Code session
at a time, one process per session (`CLAUDE.md`).

**You** write the programme, read the results and decide what changes. You have no path to
the device or to the lifter's records. The server talks to Claude over standard input and
output, and its dashboard binds `127.0.0.1` only and has no route that changes anything
(`README.md`, `src/dashboard/server.ts`).

## Responsibilities

The lifter:

- Ends each session, because a report is built only from an ended session
  (`src/tools/report-tools.ts`).
- Sends you the results, by pasting the report text or through the local outbox file
  (`README.md`, "The outbox").
- Imports your TrueCoach programming into the local plan, if you use TrueCoach
  ([Import a TrueCoach week](/coaches/import-a-truecoach-week)).
- Tells you before the first automated post into TrueCoach, if they ever turn one on
  (`README.md`, GATE 1).

Claude:

- Attaches the planned workout to the session (`plan.attach_to_session`). Only then can the
  report show a `missed:` line for a working set below your rep target (`README.md`, "Coach
  results and the outbox").
- Does not turn velocity loss into an RPE or a reps-in-reserve number
  (`plugins/voltras-channel/skills/pt-session/SKILL.md:131`).

You:

- Decide progression. Every progression line in the weekly report is labelled "suggestion
  for the coach, not applied", and nothing in the report changes a prescription
  ([Read the weekly report](/coaches/read-the-weekly-report)).

## The data loop

<svg role="img" aria-labelledby="loop-title loop-desc" viewBox="0 0 640 300" width="100%" style="max-width: 640px; color: var(--vp-c-text-1)" xmlns="http://www.w3.org/2000/svg">
  <title id="loop-title">The coach data loop</title>
  <desc id="loop-desc">Four numbered steps in a loop. 1, the lifter trains with Claude. 2, the session is saved on the lifter's machine. 3, the lifter sends the report text and the coach reads it. 4, the coach writes next week in TrueCoach, and the lifter imports it, which leads back to step 1.</desc>
  <defs>
    <marker id="loop-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L10,5 L0,10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect x="12" y="12" width="616" height="118" rx="8" fill="none" stroke="currentColor" stroke-dasharray="6 4"/>
  <text x="24" y="30" font-size="13" fill="currentColor">On the lifter's machine</text>
  <rect x="30" y="42" width="220" height="70" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="140" y="72" font-size="15" font-weight="600" text-anchor="middle" fill="currentColor">1. Lifter trains</text>
  <text x="140" y="94" font-size="13" text-anchor="middle" fill="currentColor">Claude runs the session</text>
  <rect x="390" y="42" width="220" height="70" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="500" y="72" font-size="15" font-weight="600" text-anchor="middle" fill="currentColor">2. Session saved</text>
  <text x="500" y="94" font-size="13" text-anchor="middle" fill="currentColor">local store, ~/.voltras</text>
  <rect x="390" y="200" width="220" height="70" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="500" y="230" font-size="15" font-weight="600" text-anchor="middle" fill="currentColor">3. Coach reads</text>
  <text x="500" y="252" font-size="13" text-anchor="middle" fill="currentColor">session and weekly report</text>
  <rect x="30" y="200" width="220" height="70" rx="6" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="140" y="230" font-size="15" font-weight="600" text-anchor="middle" fill="currentColor">4. Coach plans</text>
  <text x="140" y="252" font-size="13" text-anchor="middle" fill="currentColor">next week, in TrueCoach</text>
  <line x1="252" y1="77" x2="386" y2="77" stroke="currentColor" stroke-width="2" marker-end="url(#loop-arrow)"/>
  <text x="319" y="68" font-size="12" text-anchor="middle" fill="currentColor">session ends</text>
  <line x1="500" y1="114" x2="500" y2="196" stroke="currentColor" stroke-width="2" marker-end="url(#loop-arrow)"/>
  <text x="510" y="164" font-size="12" fill="currentColor">lifter sends the text</text>
  <line x1="388" y1="235" x2="254" y2="235" stroke="currentColor" stroke-width="2" marker-end="url(#loop-arrow)"/>
  <line x1="140" y1="198" x2="140" y2="116" stroke="currentColor" stroke-width="2" marker-end="url(#loop-arrow)"/>
  <text x="150" y="164" font-size="12" fill="currentColor">lifter imports the week</text>
</svg>

Text description of the diagram, step by step:

1. **The lifter trains.** Claude runs the session on the Voltra and records each set.
2. **The session is saved on the lifter's machine.** When the session ends, its sets stay
   in the local store. `report.session_results` renders them as one result string per
   exercise, and `report.weekly` rolls a date range up. Both read the store and make no
   network call (`src/tools/report-tools.ts`).
3. **The lifter sends the text, and you read it.** The lifter pastes the report, or reads
   it from the outbox file that `session.end` can write (`README.md`, "The outbox"). See
   [Read a session report](/coaches/read-a-session-report) and
   [Read the weekly report](/coaches/read-the-weekly-report).
4. **You write the next week.** In TrueCoach, you assign workouts as usual. The lifter asks
   Claude to import that week, which calls `truecoach.import_week` and turns your workouts
   into the local plan. The import only reads from TrueCoach (`src/tools/truecoach-tools.ts`).
   The next session runs against that plan, and the loop starts again.

The dashed box marks where the records are kept. Only step 3 carries anything to you, and
it carries report text. What is shared, and how to stop it, is on
[Consent and the data loop](/coaches/consent-and-data-loop).
