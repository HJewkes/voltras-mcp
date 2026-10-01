---
layout: home
title: voltras-mcp
hero:
  name: voltras-mcp
  text: Let Claude run your Voltra workout
  tagline: An MCP server that connects to a Voltra trainer, sets the load, records every set and rep, and shows each one live on a local wall dashboard.
  image:
    src: /logo.svg
    alt: The voltras-mcp logo
  actions:
    - theme: brand
      text: Get started
      link: /start/
    - theme: alt
      text: See the dashboard
      link: /guides/dashboard
    - theme: alt
      text: See it without a device
      link: /start/try-without-a-device
features:
  - title: Watch every set live
    details: A local wall dashboard shows the set as it happens, rep by rep, with the prescription beside it. When the session ends, it reads the session back.
    link: /guides/dashboard
    linkText: Read the dashboard overview
  - title: Fatigue you can see
    details: The live page draws each rep's speed against the velocity-loss lines and gives a fatigue verdict, and the session summary reads it back. It shows no effort number yet.
    link: /guides/dashboard-fatigue
    linkText: Read the fatigue tour
  - title: Plans on screen
    details: Programs, blocks, weeks and workouts live in the plan tools. The dashboard's plan builder shows the workout and edits it by hand, and a lift Claude adds appears without a reload.
    link: /guides/dashboard-plan-builder
    linkText: See the plan builder
  - title: Reports for your coach
    details: A plain-text result for each session and a weekly rollup, both read from the local store. A coach installs nothing.
    link: /coaches/
    linkText: Read For coaches
diataxis: overview
audience: [lifter, coach, developer]
status: available
sources:
  - README.md
  - CLAUDE.md
  - docs/screenshot-harness.md
  - docs/architecture/future-convergence-deep-dive.md
  - plugins/voltras-channel/skills/pt-session/SKILL.md
  - src/dashboard/server.ts
  - src/dashboard/write-guard.ts
  - src/actions/allowlist.ts
  - src/state/velocity-loss-intent.ts
  - src/dashboard/spa/planner/planner-client.ts
  - src/tools/report-tools.ts
  - site/guides/dashboard.md
  - site/guides/dashboard-setup.md
  - site/guides/dashboard-tour.md
  - site/concepts/fatigue-and-pacing.md
  - site/coming-soon/effort-readout.md
  - site/coaches/index.md
  - site/coaches/consent-and-data-loop.md
  - site/coming-soon/index.md
  - site/public/captures/manifest.json
lastVerified: 2026-09-30
sourced: 2026-09-30
---

## The dashboard

Every set you record shows up on a local web page as you lift it. Put it on a screen you can
see from the machine; [Set it up and open it](/guides/dashboard-setup) gets it there.

![The live page mid-set, with the prescribed sets, reps, load and tempo attached.](/captures/live-mid-set.png)

**Mid-set.** Each rep's speed against the velocity-loss lines (20% and 30% at the default
hypertrophy goal), the fatigue card and the prescription. [The live workout tour](/guides/dashboard-tour#mid-set-with-a-plan-attached)
walks through it.

![The rest stage between two sets of a planned exercise.](/captures/live-rest.png)

**Between sets.** The set you just finished, its verdict and the rest ring.
[The live workout tour](/guides/dashboard-tour#between-sets) walks through it.

![The session-completion screen for the session that just ended.](/captures/session-summary.png)

**After the session.** Totals, the fatigue verdict, each set and a load recommendation for
next time. [The live workout tour](/guides/dashboard-tour#session-complete) walks through it.

The mock adapter drives these three captures, not a real Voltra: each one runs the real MCP
tools against `VOLTRA_ADAPTER=mock` (`docs/screenshot-harness.md`,
`site/public/captures/manifest.json`).

## How the cards above are backed

- **Watch every set live.** The dashboard is a local web page that the server starts beside
  the MCP server (`site/guides/dashboard.md`). The live page shows the prescription next to
  the set, and the session summary reads a finished session back (`live-mid-set` and
  `session-summary` in `site/public/captures/manifest.json`).
- **Fatigue you can see.** The live page draws two velocity-loss lines, at two thirds of the
  goal's stop threshold and at the threshold itself, and a fatigue card
  (`src/state/velocity-loss-intent.ts:130-143`), and the session summary repeats the verdict (`site/public/captures/manifest.json`,
  `site/concepts/fatigue-and-pacing.md`). The effort number (RPE or reps in reserve) is
  withheld until a lift has a trusted fitted profile (`site/coming-soon/effort-readout.md`).
- **Plans on screen.** The [`plan.*`](/reference/plan) tools hold programs, blocks, weeks,
  workout templates and planned exercises (`README.md`). The plan builder at `/app#/plan`
  re-reads the plan every 2 seconds, so a lift added over MCP appears without a reload
  (`src/dashboard/spa/planner/planner-client.ts:25`).
- **Reports for your coach.** [`report.session_results`](/reference/report) and
  [`report.weekly`](/reference/report) read the store and make no network call
  (`src/tools/report-tools.ts`, `site/coaches/index.md`).

## Where to start

### I lift with a Voltra

- [Open the dashboard](/guides/dashboard-setup)
- [Run your first session](/start/first-session)
- [Run a planned session](/guides/planned-session)

### I want to see my training on a screen

- [The wall dashboard](/guides/dashboard)
- [The live workout tour](/guides/dashboard-tour)

### I coach a lifter

- [The onboarding model](/coaches/onboarding-model)
- [Read a session report](/coaches/read-a-session-report)

### I am evaluating the MCP tools

- [Try it without a device](/start/try-without-a-device)
- [Page status: what each badge promises](/status)

## What it is, and what it is not

- **A stdio MCP server.** It talks to Claude Code over standard input and output, and each
  Claude Code session runs its own server process (`README.md`, `CLAUDE.md`).
- **Not on npm.** You clone the repository and build it. `npx voltras-mcp` does not work
  (`README.md`, "Quickstart").
- **Local.** Your training records live in one SQLite file on your machine,
  `~/.voltras/vmcp.sqlite` unless `VMCP_DB_PATH` moves it (`CLAUDE.md`). The dashboard binds
  `127.0.0.1` only, so no other machine can open it (`src/dashboard/server.ts`). Its write
  routes edit plans or run a short allowlist of store-only actions, such as logging bodyweight
  or answering a weekly check-in; none of them drives the device
  (`src/actions/allowlist.ts:41-101`). Each write needs a same-origin request carrying a
  per-boot token (`src/dashboard/write-guard.ts`). Tool results do go into your conversation with Claude,
  because that is how Claude reads them (`site/coaches/consent-and-data-loop.md`).
- **Not a medical device.** It makes no health claims. When onboarding raises a cardiovascular
  flag, the coach skill reads the note out and sends you to a doctor instead of programming
  around it (`plugins/voltras-channel/skills/pt-session/SKILL.md`,
  [`profile.get_onboarding_gaps`](/reference/profile)).
- **Not the mobile app.** The Voltras mobile app is a separate project. It owns the Bluetooth
  connection on the phone, while here the server owns the connection and the dashboard renders
  what the server reports (`docs/architecture/future-convergence-deep-dive.md`).

## Coming soon

Some dashboard screens exist in the code but are not yet usable, including the
[goals page](/coming-soon/goals-page). The [Coming soon](/coming-soon/) section lists each one and
what is missing (`site/coming-soon/index.md`).
