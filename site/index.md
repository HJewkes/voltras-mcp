---
layout: home
title: voltras-mcp
hero:
  name: voltras-mcp
  text: Let Claude run your Voltra workout
  tagline: An MCP server that connects to a Voltra trainer, sets the load, records every set and rep, and reports on the history.
  image:
    src: /logo.svg
    alt: The voltras-mcp logo
  actions:
    - theme: brand
      text: Get started
      link: /start/
    - theme: alt
      text: See it without a device
      link: /start/try-without-a-device
    - theme: alt
      text: Capability reference
      link: /reference/
features:
  - title: Live set coaching
    details: Claude sets the load, opens and closes each set, and receives each rep as it is recorded. A local wall dashboard shows the set as it happens.
    link: /guides/dashboard
    linkText: Read the dashboard guide
  - title: Velocity-based analytics
    details: The server records the speed of every rep and the velocity loss across a set. It states an effort number only for a lift with an effort curve fitted to you.
    link: /concepts/velocity-and-effort
    linkText: Read Velocity and effort
  - title: Plans and goals
    details: Programs, blocks, weeks and workouts live in the plan tools, and the dashboard's plan builder edits a workout by hand. Goal tracking is coming soon.
    link: /guides/dashboard#the-four-pages
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
  - docs/push-events.md
  - docs/screenshot-harness.md
  - docs/architecture/future-convergence-deep-dive.md
  - plugins/voltras-channel/skills/pt-session/SKILL.md
  - src/dashboard/server.ts
  - src/dashboard/write-guard.ts
  - src/tools/report-tools.ts
  - site/guides/dashboard.md
  - site/concepts/velocity-and-effort.md
  - site/coaches/index.md
  - site/coaches/consent-and-data-loop.md
  - site/coming-soon/index.md
  - site/coming-soon/goals-page.md
  - site/public/captures/manifest.json
lastVerified: 2026-09-27
---

## How the cards above are backed

- **Live set coaching.** Claude drives the device and the set lifecycle through the `device.*`
  and `set.*` tools, and the server pushes a `rep_finalized` event per rep into the
  conversation (`README.md`, `docs/push-events.md`). The dashboard is a local web page served
  alongside the server (`site/guides/dashboard.md`).
- **Velocity-based analytics.** [`metrics.compute`](/reference/metrics) reports velocity loss per
  set, and the coach skill states no RPE or reps in reserve until a lift has a trusted fitted
  profile (`site/concepts/velocity-and-effort.md`,
  `plugins/voltras-channel/skills/pt-session/SKILL.md`).
- **Plans and goals.** The [`plan.*`](/reference/plan) tools hold programs, blocks, weeks,
  workout templates and planned exercises, and `/app#/plan` is the dashboard's plan builder
  (`README.md`, `site/guides/dashboard.md`). The goals page is not yet usable
  (`site/coming-soon/goals-page.md`).
- **Reports for your coach.** [`report.session_results`](/reference/report) and
  [`report.weekly`](/reference/report) read the store and make no network call
  (`src/tools/report-tools.ts`, `site/coaches/index.md`).

## Where to start

### I lift with a Voltra

- [Run your first session](/start/first-session)
- [Run a planned session](/guides/planned-session)

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
  `127.0.0.1` only, so no other machine can open it (`src/dashboard/server.ts`). Its only write
  routes edit plans, and each one needs a same-origin request carrying a per-boot token
  (`src/dashboard/write-guard.ts`). Tool results do go into your conversation with Claude,
  because that is how Claude reads them (`site/coaches/consent-and-data-loop.md`).
- **Not a medical device.** It makes no health claims. When onboarding raises a cardiovascular
  flag, the coach skill reads the note out and sends you to a doctor instead of programming
  around it (`plugins/voltras-channel/skills/pt-session/SKILL.md`,
  [`profile.get_onboarding_gaps`](/reference/profile)).
- **Not the mobile app.** The Voltras mobile app is a separate project. It owns the Bluetooth
  connection on the phone, while here the server owns the connection and the dashboard renders
  what the server reports (`docs/architecture/future-convergence-deep-dive.md`).

## The live page, mid-set

![The wall dashboard's live page mid-set on Cable Chest Press: the prescription of 3 sets of 8 to 10 reps at 140 lb, a velocity chart for the current set with the 20% and 30% velocity-loss lines, and the fatigue panel.](/captures/live-mid-set.png)

The mock adapter drives this capture, not a real Voltra: every published screenshot runs the
real MCP tools against `VOLTRA_ADAPTER=mock` (`docs/screenshot-harness.md`,
`site/public/captures/manifest.json`).

## Coming soon

Some dashboard screens exist in the code but are not yet usable, including the
[goals page](/coming-soon/goals-page). The [Coming soon](/coming-soon/) section lists each one and
what is missing (`site/coming-soon/index.md`).
