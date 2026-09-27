---
title: Consent and the data loop
description: What a lifter's voltras-mcp setup shares with a coach, when, and how to stop it, with TrueCoach's terms of service quoted in full.
diataxis: explanation
audience: [coach, lifter]
status: experimental
statusNote: The TrueCoach write-back described at the end of this page ships with its submit control marked unverified. Everything above that section describes shipped behaviour.
sources:
  - README.md
  - CLAUDE.md
  - src/config.ts
  - src/dashboard/server.ts
  - src/dashboard/write-guard.ts
  - src/integrations/truecoach/outbox.ts
  - src/tools/report-tools.ts
  - src/tools/session-tools.ts
  - src/tools/truecoach-tools.ts
  - tools/truecoach-submit/README.md
  - tools/truecoach-submit/src/selectors.js
lastVerified: 2026-09-27
---

# Consent and the data loop

This page is for both of you. The lifter decides what leaves their machine. The coach
should know what arrives, and what an optional automated post would put at risk on the
coach's own account.

## Local by default

With no extra settings, voltras-mcp sends nothing to anyone:

- The training records live in one SQLite file on the lifter's machine,
  `~/.voltras/vmcp.sqlite` unless `VMCP_DB_PATH` moves it (`README.md`, "Environment
  variables").
- The dashboard binds `127.0.0.1` only, so no other machine can open it. Its live-view
  routes are reads; it also serves a small set of plan-editing routes used by the plan
  builder page, each behind the write guard in `src/dashboard/write-guard.ts` (`README.md`,
  "The dashboard"; `src/dashboard/server.ts:242`, `src/dashboard/write-guard.ts:85-95`).
- `report.session_results` and `report.weekly` read the store and make no network call
  (`src/tools/report-tools.ts`).
- The outbox file drop and the automated TrueCoach post are both off by default
  (`src/config.ts`, `VMCP_TRUECOACH_OUTBOX` and `VMCP_TRUECOACH_SUBMIT_ON_END`).
- The TrueCoach import makes no network call until the lifter configures credentials. With
  none set it returns `NOT_CONFIGURED` (`README.md`, "Setup").

One thing does leave the lifter's machine in every session: tool results go into the
lifter's conversation with Claude, because that is how Claude reads them (`CLAUDE.md`). That
conversation belongs to the lifter's own Claude Code session, and this server does not
control it.

## What reaches the coach, and when

| What                      | When it reaches the coach                                                                                                | Source                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| One session's result text | When the lifter sends it. `report.session_results` only renders it.                                                      | `src/tools/report-tools.ts`         |
| The weekly rollup         | When the lifter sends it. `report.weekly` only renders it.                                                               | `src/tools/report-tools.ts`         |
| An outbox file            | Never on its own. With `VMCP_TRUECOACH_OUTBOX=on`, each `session.end` writes a local file that nothing reads or uploads. | `README.md`, "The outbox"           |
| A post into TrueCoach     | Only if the lifter installs and runs the separate write-back tool. See the last section.                                 | `README.md`, "TrueCoach write-back" |

Some sets never appear in a report. A guest lifter's sets, mock-adapter sets and zero-rep
sets are left out, and an exercise with no working set is omitted (`README.md`, "Coach
results and the outbox"). A guest is whoever the lifter names with `session.set_lifter`
before the guest's sets; the owner's baselines, progression and history then stay clean
(`src/tools/session-tools.ts`).

## How to stop it

- **Stop sending.** No report reaches the coach unless the lifter sends it, or unless the
  write-back below is turned on.
- **Turn the outbox off.** Set `VMCP_TRUECOACH_OUTBOX=off`, which is the default. Files
  already written stay under `~/.voltras/truecoach-outbox/pending/` until the lifter deletes
  them (`README.md`, "The outbox").
- **Turn the automated post off.** Set `VMCP_TRUECOACH_SUBMIT_ON_END=off`, the default, and
  remove the daily launchd job if the lifter installed one. The package never installs that
  job itself (`tools/truecoach-submit/README.md`, "Scheduling").
- **Stop the import.** Remove `VMCP_TRUECOACH_USERNAME` and the password settings, and the
  tool returns `NOT_CONFIGURED` with no network call. The cached access token is at
  `~/.voltras/truecoach-token.json` and raw responses are under `~/.voltras/truecoach-cache/`
  (`README.md`, "Setup").

## TrueCoach import: read-only, and the coach has not consented

`truecoach.import_week` reads the lifter's own assigned workouts from TrueCoach. It never
writes to TrueCoach, and it runs only when called, with no background sync
(`src/tools/truecoach-tools.ts`). The README's terms-of-service passage for the import, quoted
in full (`README.md:579-595`):

> TrueCoach (an Xplor Technologies brand) **publishes no public developer API**. The
> endpoint this uses is undocumented and reverse-engineered. Xplor's terms of use, section
> A.4 "Prohibited Activities", say you will not:
>
> > (c) use any robot, spider, crawler, scraper, or other manual or automated means or
> > interface to access the Services, retrieve, index, scrape, "data mine" or otherwise
> > gather Content or extract other user's information.
> >
> > (d) use or develop any third-party applications that interact with the Services or other
> > users' content or information without our written consent.
>
> Clause (c) is arguably narrowed by "other user's information", which this is not. Clause
> (d) has no such qualifier. **The position taken here is a deliberate one**: this is a
> client-role read of your OWN data on your OWN account, run by hand, with no write path and
> no automation. The coach has not been asked for consent, and TrueCoach has not granted
> written consent under clause (d). The account at risk is yours. Do not present this as a
> sanctioned integration, and do not point it at anyone else's account.

The server itself has no write path to TrueCoach (`README.md:597-601`).

## TrueCoach write-back: experimental and gated

::: warning Experimental
The write-back tool's submit control ships marked UNVERIFIED: nobody has clicked it
(`tools/truecoach-submit/src/selectors.js:31`). The dry run is the step that verifies it
(`README.md`, "First run").
:::

`tools/truecoach-submit/` reads the outbox and posts one session's results into that day's
TrueCoach workout with a local browser. It is a separate package: the server does not
bundle it, the root `npm ci` does not install it, and CI does not run it (`README.md`,
"TrueCoach write-back"). The README's gates, quoted in full (`README.md:665-670`):

> **GATE 1.** Xplor ToS A.4(d) forbids third-party apps interacting with the service without
> written consent; this job is the human's accepted risk on their own client account, and the
> coach should be told before the first real submit.
>
> **GATE 2.** Any DOM selector change fails closed: if one expected element is missing, nothing
> is filled and nothing is submitted; there are no partial posts.

And its terms-of-service passage, quoted in full (`README.md:674-693`):

> TrueCoach's terms are Xplor's. Section A.4 "Prohibited Activities" says you will not:
>
> > (c) use any robot, spider, crawler, scraper, or other manual or automated means or
> > interface to access the Services, retrieve, index, scrape, "data mine" or otherwise
> > gather Content or extract other user's information.
> >
> > (d) use or develop any third-party applications that interact with the Services or other
> > users' content or information without our written consent.
>
> This is unambiguous and it covers both directions. Clause (c) is arguably narrowed by "other
> user's information" on the extraction clause, but clause (d) has no such qualifier and
> prohibits developing any interacting third-party application without written consent. Any
> automated route — undocumented API, scraper, or browser automation — is against these terms,
> and the account at risk is the coach's business account as much as the athlete's.
>
> The practical read: the terms make an automated integration a policy risk, not a technical
> one. Asking the coach to ask TrueCoach for written consent, or simply keeping a human
> clicking the submit button, are the two ways to stay on the right side of it.
>
> **Tell the coach before the first real submit.** They carry account risk they did not choose.

The tool's own README adds one sentence for the coach: results that appear without a human
typing them are "a change to how they read your log" (`tools/truecoach-submit/README.md`,
"The terms of service, in full").
