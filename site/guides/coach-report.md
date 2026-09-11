# Coach reports and the outbox

By the end of this you'll know what [`report.session_results`](/reference/report) writes,
how to read the load labels on non-weight modes, what the TrueCoach outbox does and does
not do, and where the write-back submitter lives and why it's a separate, gated tool.

This assumes the [first-session guide](/guides/first-session) already — a report is built
from a session you've already run and ended.

## Reading a report

[`report.session_results`](/reference/report) turns one ended session into the freeform
"Result" text a coach reads, one string per exercise (`README.md`):

```
170 lb x 12
170 lb x 10
warm-up: 3 sets
missed: 1 of 3 sets below 8 reps
```

A bilateral effort renders as `L 30 lb x 13` / `R 30 lb x 12`. The `missed:` line only
appears when the session had a plan attached (`plan.complete_workout` /
`plan.attach_to_session`) and a working set fell below its `targetRepsLow` (`README.md`).

Which sets count follows the same rule [`plan.suggest_progression`](/reference/plan) uses:
flagged warm-ups are excluded, then the sets at the top load are kept. A guest lifter's
sets (`session.set_lifter`), mock-adapter sets, and zero-rep sets never appear, and an
exercise with no working set is omitted rather than reported empty (`README.md`).

## Load labels on non-weight modes

A Damper, Band, or Isokinetic set has no weight to report, so it labels itself by its own
setting instead of showing a missing number: `damper 6 x 10`, `band x 10`, `iso x 10`. Band
max force is never in the label — the device doesn't echo it back in any observed frame, so
there's nothing to report. `describeLoad` in `src/state/set-capture.ts` is the one place
this decision is made, and the dashboard's session summary and set list render the same
string (`README.md`, PR #271).

## What the tool does and doesn't do

`report.session_results` reads the store and makes **no network call**. It never writes to
TrueCoach, and nothing in this server does (`README.md`).

## The outbox is a file drop, not a pipe

Set `VMCP_TRUECOACH_OUTBOX=on` and every `session.end` also writes the same payload, plus a
`generatedAt` stamp, to:

```
~/.voltras/truecoach-outbox/pending/<sessionId>.json
```

`VMCP_TRUECOACH_OUTBOX_DIR` moves the root; `pending/` is created on demand, mode `0700`.
Nothing reads the directory, nothing uploads it, and nothing schedules anything — it exists
so a session's results survive the conversation that produced them, ready to paste
(`README.md`). A session with no working sets writes nothing, and a write failure is logged
and swallowed; the file is a by-product of `session.end`, never a precondition for it.

The example above is a synthetic result for an invented exercise, not a real session — this
page never shows real athlete data, a real session id, or a real TrueCoach account.

## The write-back submitter is separate, opt-in, and carries account risk

Posting a report's text into TrueCoach isn't something this server does. `tools/truecoach-submit/`
is a **standalone package**: its own `package.json`, its own lockfile, not part of the
server bundle, not installed by the root `npm ci`, not run by CI (`tools/truecoach-submit/package.json`).
It reads the outbox and drives a local Playwright browser to fill in that day's TrueCoach
workout.

Two things gate it, and both are read before anything runs (`tools/truecoach-submit/README.md`):

- **TrueCoach's terms of service.** TrueCoach is an Xplor Technologies brand, and Xplor's
  terms prohibit third-party applications interacting with the service without written
  consent. That makes an automated write path a policy risk the coach carries on their own
  business account, not a technical one this tool can route around — tell the coach before
  the first real submit. This page isn't legal advice; read the submitter's own README for
  the terms in full before running it.
- **Selector changes fail closed.** If TrueCoach's page is missing an element the submitter
  expects, nothing is filled and nothing is submitted — there are no partial posts
  (`tools/truecoach-submit/README.md`).

The submit button's own selector ships marked `UNVERIFIED` in source: nobody has clicked it
yet, so the first real run is also the first verification of that one constant
(`tools/truecoach-submit/src/selectors.js:28-45`).

By default a human runs the submitter by hand. One environment variable changes that:
`VMCP_TRUECOACH_SUBMIT_ON_END=on` (with the outbox also on) makes every outbox write spawn
`tools/truecoach-submit --submit --session <id>` itself, detached, once per session —
turning "a person chooses to post this" into "ending a session posts it" with no further
action from you. Read both gates above before setting it, since it's the trigger that puts
the account risk on autopilot (`README.md`).

Pulling a coach's assigned workouts the other direction — TrueCoach into the local plan
tree — is a different, already-read-only tool: see
[`truecoach.import_week`](/reference/truecoach).

## What to read next

- The [`report.*` reference](/reference/report) for the tool's full schema.
- The [`truecoach.*` reference](/reference/truecoach) for the read-only pull path.
- [The planned-session guide](/guides/planned-session) for what makes a set count toward
  `missed:`.
