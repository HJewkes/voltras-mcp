# truecoach-submit

Posts ONE voltras-mcp session's results into that day's TrueCoach workout, unattended.

Read both gates before you run anything.

## GATES

**GATE 1.** Xplor ToS A.4(d) forbids third-party apps interacting with the service without
written consent; this job is the human's accepted risk on their own client account, and the
coach should be told before the first real submit.

**GATE 2.** Any DOM selector change fails closed: if one expected element is missing, nothing
is filled and nothing is submitted; there are no partial posts.

## The terms of service, in full

TrueCoach (an Xplor Technologies brand) publishes no public developer API. Xplor's terms of
use, section A.4 "Prohibited Activities", say you will not:

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

**Tell the coach before the first real submit.** They carry account risk they did not choose,
and the results appearing without a human typing them is a change to how they read your log.

Full research: `sources/notes/2026-09-08-truecoach-integration-research.md`, sections 4 and 5.

## Why it is standalone

Playwright is heavy and the server's lockfile carries Linux-only optional peers that darwin
npm drops. This package has its own `package.json` and lockfile, is installed only on the
human's machine, and is excluded from the root `npm ci`, the root scripts, the root
tsconfig/eslint/prettier globs, and CI. Never `npm install --save` into the server package
on its behalf.

It is plain ESM JavaScript, not TypeScript: no build step means the `bin` runs the source
that the tests ran, and a launchd job cannot fire against a stale `dist/`.

Install:

```
cd tools/truecoach-submit
npm ci
npx playwright install chromium   # ~140 MB download, once
```

## First-run sequence

```
truecoach-submit login                       # headed; you sign in and pass MFA yourself
truecoach-submit                             # dry run over everything pending
open ~/.voltras/truecoach-outbox/screens/…   # read the screenshot
truecoach-submit --submit --session <id>     # one session, for real
```

`login` opens a headed Chromium on the workouts page and waits for you to close the window.
The tool never types a password, in that command or any other. The signed-in profile lives at
`~/.voltras/truecoach-profile/`.

**The dry run is the verification step for the submit selector.** `SUBMIT_CONTROL` in
`src/selectors.js` is marked UNVERIFIED: it is derived from mcummins/hevy-truecoach-sync,
which deliberately never clicks submit, so nobody has exercised it. Read the screenshot, look
at the button the page actually renders, and correct the constant before your first
`--submit`.

## Reading the screenshot

Every pass writes a full-page PNG to
`~/.voltras/truecoach-outbox/screens/<sessionId>-<timestamp>.png`, after filling and before
submitting. On a dry run that is the last thing that happens; the entry stays pending. Check
that each exercise's results box holds the block you expect and that nothing landed on the
wrong exercise.

## CLI

```
truecoach-submit [--submit] [--session <id> | --all] [--stale-hours N]
truecoach-submit login
```

Default is a dry run over every pending entry. `--submit` is the only flag that clicks
anything. `--headed` shows the browser during a run, for debugging.

Exit codes: `0` every entry settled cleanly, `1` at least one refusal, `2` TrueCoach asked for
a login.

## Per-session rules

One entry is one TrueCoach workout is one browser pass.

1. **Ledger first.** An entry whose every exercise is already in the ledger is moved to
   `sent/` and skipped. An entry with SOME exercises in the ledger is refused with
   `ledger_partial` and left for you — the tool cannot tell whether the rest failed or posted
   and got lost, and guessing wrong double-posts into the coach's workout.
2. **Freshness.** Refused when the entry has no exercises, when `generatedAt` precedes
   `endedAt`, or when the session ended more than `--stale-hours` ago (default 36). The coach's
   calendar day rolls; a stale post lands on the wrong workout. Refused entries stay pending
   and are listed in the exit report.
3. **Browser.** Headless, on the persistent profile. If a login form or MFA prompt appears the
   whole run stops, raises the session id through `agent-chat ask` (falling back to a macOS
   notification) and exits non-zero. No retry.
4. **Locate.** The workout for the entry's `date`, under Upcoming first and then Past. Every
   exercise is resolved to exactly one `textarea[placeholder="Enter results"]` by name-matching
   the card, never by index — supersets reorder. Zero or multiple matches for any exercise, or
   no workout for that day, aborts the entry with no fills.
5. **Fill all.** Native value setter plus a bubbling `input` event, appending to non-empty
   content with a newline, never overwriting. Then the screenshot.
6. **Dry run stops here.**
7. **`--submit`** clicks the submit control once, waits for the page to settle, appends every
   exercise to the ledger and moves the entry to `sent/`. A missing submit control aborts with
   NO click.

## The ledger

`~/.voltras/truecoach-outbox/ledger.json`, append-only, one record per posted exercise:

```json
{ "entries": [{ "sessionId": "…", "exerciseId": "…", "sentAt": "…", "screenshot": "…" }] }
```

To re-post one session, delete that session's records and move its JSON back from `sent/` to
`pending/`:

```
node -e 'const f="'"$HOME"'/.voltras/truecoach-outbox/ledger.json",fs=require("fs");
const l=JSON.parse(fs.readFileSync(f));
l.entries=l.entries.filter(e=>e.sessionId!=="SESSION_ID_HERE");
fs.writeFileSync(f,JSON.stringify(l,null,2)+"\n");'
mv ~/.voltras/truecoach-outbox/{sent,pending}/SESSION_ID_HERE.json
```

That is the only supported edit to the ledger. Removing a record makes a re-post possible, so
do it only when you have confirmed the results are not in TrueCoach.

## Scheduling

`launchd/co.voltras.truecoach-submit.plist` runs `--submit --all` once a day at 21:30, after
typical training hours. It is not installed by this package: copy it to
`~/Library/LaunchAgents/`, fix the placeholder paths, and `launchctl bootstrap`. It uses
`StartCalendarInterval`, never `StartInterval` — one clock-driven run, no polling.

The server can also trigger a single run: `VMCP_TRUECOACH_SUBMIT_ON_END='on'` (default off,
requires `VMCP_TRUECOACH_OUTBOX='on'`) makes the outbox writer spawn
`truecoach-submit --submit --session <id>` once, detached, right after writing the entry.

**Use one trigger at a time.** Both the launchd job and the server trigger together means two
processes can drive the same entry; the ledger makes the second a no-op only if the first has
already finished writing it.

## Tests

```
npm test
```

No network and no browser: the page scripts are the real ones, recompiled inside jsdom. One
Playwright smoke test starts a real chromium and stops at the dry-run screenshot; it is gated
behind `TRUECOACH_SMOKE=1` and never runs in CI.

## Known limitation

hevy-truecoach-sync's runbook records (2026-08-31) that "Update results" only saves exercises
TrueCoach considers dirty, and that a text-only edit on an already-completed exercise is not
dirty — its appended text can be silently dropped on save. Their workaround is to re-touch
each exercise's `button.exerciseStatus` toggle before saving. This tool does not do that: the
toggle is the coach's completion state, and cycling it is a larger change than posting text.
If your first `--submit` reloads to find the results missing, that is this. Report it rather
than re-running, because a re-run posts again.
