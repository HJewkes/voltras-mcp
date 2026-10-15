---
title: TrueCoach import, outbox and write-back
description: The read-only TrueCoach pull, the coach-results text and its local outbox, and the separate, gated write-back tool, with the terms-of-service position each one takes.
diataxis: how-to
audience: [lifter, coach, developer]
status: available
sources:
  - src/tools/truecoach-tools.ts
  - src/integrations/truecoach/client.ts
  - src/integrations/truecoach/instruction.ts
  - src/integrations/truecoach/map.ts
  - src/integrations/truecoach/outbox.ts
  - src/tools/report-tools.ts
  - src/state/set-capture.ts
  - src/config.ts
  - tools/truecoach-submit/README.md
lastVerified: 2026-10-15
sourced: 2026-10-15
---

# TrueCoach import, outbox and write-back

Three separate pieces, each off until you turn it on:

- [`truecoach.import_week`](/reference/truecoach) pulls a coach's assigned workouts into the
  local plan. Read-only.
- [`report.session_results`](/reference/report) renders one ended session as the result
  text a coach reads, and the optional outbox drops that text in a local file.
- `tools/truecoach-submit/`, a standalone package outside the server, posts those results
  into TrueCoach with a local browser. It is the only piece that writes, and it is gated.

::: warning Terms of service
TrueCoach publishes no public developer API, and its terms forbid third-party applications
that interact with the service without written consent. Read
[Terms of service](#terms-of-service-read-this-before-using-it) before using any of this.
The account at risk is yours, and for the write-back, your coach's too.
:::

## The read-only pull

`truecoach.import_week` pulls the coach-assigned workouts for a date range out of a
TrueCoach account and upserts them into the local `plan.*` tree. It is **off unless you
configure it**, it **only runs when you call it** (no timer, no startup hook, no
background sync), and it **never writes to TrueCoach**: the only non-GET request it can
make is the OAuth password grant.

### Setup

```bash
# Put the password in the macOS keychain once:
security add-generic-password -a "$USER" -s truecoach -w

export VMCP_TRUECOACH_USERNAME='you@example.com'
export VMCP_TRUECOACH_PASSWORD_CMD='security find-generic-password -a "$USER" -s truecoach -w'
```

`VMCP_TRUECOACH_PASSWORD` works too, but it puts the password in plaintext in your
environment. With neither set the tool returns `NOT_CONFIGURED` and makes no network
call; it never prompts.

The access token is cached in memory for its lifetime and on disk at
`~/.voltras/truecoach-token.json`, mode 0600. Raw responses are cached under
`~/.voltras/truecoach-cache/` with a 6-hour TTL; pass `refresh: true` to bypass it. Both
paths are gitignored, and neither the token nor the password is ever written to a log line
or an error message. Every variable is listed in the
[environment variable reference](/reference/environment-variables).

### What it does

```
your program → "TrueCoach import" block → one week per ISO week → one template per workout
```

Exercise names must match the catalog **exactly** (case- and punctuation-insensitive). A
ranked "close enough" hit is never accepted: a wrong `exerciseId` silently attributes a
lift and its baselines to a movement the coach never prescribed. Unmatched names come back
in `unmapped` with up to three candidates and are skipped (the template still lands), and
you resolve them by re-running with a `mapping` from each TrueCoach name to a catalog
exercise id.

Targets are read from the coach's instruction text by a deliberately narrow parser
(`3 x 8-10 @ 135lb, rest 90s`, `50lbs x AMRAP x 4 sets`, `4 sets of 12`). Anything it
cannot read is left absent, and the **whole instruction is kept verbatim in `notes`**
either way.

Re-importing the same range is idempotent: every row carries a TrueCoach external id with
a unique index behind it, so a second run updates in place and never duplicates. Use
`dryRun: true` to see the mapped tree before writing. The step-by-step version for a coach
is [Import a TrueCoach week](/coaches/import-a-truecoach-week).

### Terms of service — read this before using it

TrueCoach (an Xplor Technologies brand) **publishes no public developer API**. The
endpoint this uses is undocumented and reverse-engineered. Xplor's terms of use, section
A.4 "Prohibited Activities", say you will not:

> (c) use any robot, spider, crawler, scraper, or other manual or automated means or
> interface to access the Services, retrieve, index, scrape, "data mine" or otherwise
> gather Content or extract other user's information.
>
> (d) use or develop any third-party applications that interact with the Services or other
> users' content or information without our written consent.

Clause (c) is arguably narrowed by "other user's information", which this is not. Clause
(d) has no such qualifier. **The position taken here is a deliberate one**: this is a
client-role read of your OWN data on your OWN account, run by hand, with no write path and
no automation. The coach has not been asked for consent, and TrueCoach has not granted
written consent under clause (d). The account at risk is yours. Do not present this as a
sanctioned integration, and do not point it at anyone else's account.

The write direction is **not** built into the server. Results in TrueCoach are freeform
text, and the only working write path anyone has found is browser automation against the
page. That path exists as a separate, opt-in tool ([write-back](#write-back-unattended-gated)
below), and nothing in the server process ever reaches TrueCoach to write.

## Coach results and the outbox

`report.session_results` turns one ended session into the block of text a coach expects to
read back: the same freeform "Result" idiom TrueCoach's own exports use, one string per
exercise.

```
170 lb x 12
170 lb x 10
warm-up: 3 sets
missed: 1 of 3 sets below 8 reps
```

A bilateral effort renders as `L 30 lb x 13` / `R 30 lb x 12`. The `missed:` line appears
only when the session had a plan attached (`plan.complete_workout` /
`plan.attach_to_session`) and a working set fell below its `targetRepsLow`.

A Damper, Band or Isokinetic set has no `weightLbs` to report, so it labels itself by its
own setting instead of showing a missing weight: `damper 6 x 10`, `band x 10`, `iso x 10`.
Band max force is never part of the label, because the device does not report it back, so
there is nothing observed to show. `describeLoad` in `src/state/set-capture.ts` is the one
place this decision is made; the dashboard's session summary and set list render the same
string.

Which sets count is decided the same way `plan.suggest_progression` decides it: flagged
warm-ups are excluded, then the sets at the top load are kept. A guest lifter's sets
(`session.set_lifter`) and zero-rep sets never appear, mock-adapter sets are left out unless
the server itself runs on the mock adapter, and an exercise with no working set is omitted
rather than reported empty. The tool reads the store and makes **no network call**.

### The outbox

Set `VMCP_TRUECOACH_OUTBOX=on` and every `session.end` also drops the same payload, plus a
`generatedAt` stamp, at:

```
~/.voltras/truecoach-outbox/pending/<sessionId>.json
```

`VMCP_TRUECOACH_OUTBOX_DIR` moves the root; `pending/` is created on demand, mode 0700.
This is a **local file drop, not a pipe**: the server never reads the directory back,
uploads it or schedules anything. Only the separate write-back tool below reads it, and only
when you run it or turn on `VMCP_TRUECOACH_SUBMIT_ON_END`. It exists so the results of a
session survive the conversation that produced them, ready to paste.

A session with no working sets writes nothing (logged at `debug`), and a write failure is
logged and swallowed: the file is a by-product of `session.end`, never a precondition for
it.

## Write-back (unattended, gated)

`tools/truecoach-submit/` consumes the outbox and posts one session's results into that
day's TrueCoach workout with a local Playwright browser. It is a standalone package: not
part of the server bundle, not installed by the root `npm ci`, not run by CI. Its full
documentation is
[`tools/truecoach-submit/README.md`](https://github.com/HJewkes/voltras-mcp/blob/main/tools/truecoach-submit/README.md).
Read both gates first.

**GATE 1.** Xplor ToS A.4(d) forbids third-party apps interacting with the service without
written consent; this job is the human's accepted risk on their own client account, and the
coach should be told before the first real submit.

**GATE 2.** Any DOM selector change fails closed: if one expected element is missing, nothing
is filled and nothing is submitted; there are no partial posts.

### The terms of service

TrueCoach's terms are Xplor's. Section A.4 "Prohibited Activities" says you will not:

> (c) use any robot, spider, crawler, scraper, or other manual or automated means or
> interface to access the Services, retrieve, index, scrape, "data mine" or otherwise
> gather Content or extract other user's information.
>
> (d) use or develop any third-party applications that interact with the Services or other
> users' content or information without our written consent.

This is unambiguous and it covers both directions. Clause (c) is arguably narrowed by "other
user's information" on the extraction clause, but clause (d) has no such qualifier and
prohibits developing any interacting third-party application without written consent. Any
automated route — undocumented API, scraper, or browser automation — is against these terms,
and the account at risk is the coach's business account as much as the athlete's.

The practical read: the terms make an automated integration a policy risk, not a technical
one. Asking the coach to ask TrueCoach for written consent, or simply keeping a human
clicking the submit button, are the two ways to stay on the right side of it.

**Tell the coach before the first real submit.** They carry account risk they did not choose.

### First run

```
cd tools/truecoach-submit && npm ci && npx playwright install chromium   # ~140 MB, once
truecoach-submit login                       # headed; you sign in and pass MFA yourself
truecoach-submit                             # dry run over everything pending
open ~/.voltras/truecoach-outbox/screens/…   # read the screenshot
truecoach-submit --submit --session <id>     # one session, for real
```

The tool never types a password. The dry run is also the verification step for the submit
selector, which ships marked UNVERIFIED: nobody has clicked it, so confirm it against the
screenshot before the first `--submit`.

### The ledger, and resetting one session

Every posted exercise is appended to `~/.voltras/truecoach-outbox/ledger.json`. A rerun of a
fully-recorded session is a no-op; a half-recorded one is refused rather than reconciled. To
re-post a session, remove its records from the ledger and move its JSON from `sent/` back
to `pending/`; the procedure is in the tool's README. Do that only after confirming the
results are not already in TrueCoach.

### Scheduling

`tools/truecoach-submit/launchd/` holds a documented plist (not installed by the package)
running `--submit --all` once a day after training hours. Alternatively
`VMCP_TRUECOACH_SUBMIT_ON_END=on` makes the server spawn the submitter once per written
entry, detached. Use one trigger at a time.

For what reaches the coach and when, and how to stop each piece, see
[Consent and the data loop](/coaches/consent-and-data-loop).
