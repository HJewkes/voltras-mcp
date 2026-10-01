---
diataxis: tutorial
audience: [lifter]
status: available
sources:
  - src/tools/session-tools.ts
  - src/tools/set-tools.ts
  - src/schemas/session.ts
  - src/schemas/set.ts
  - src/state/event-bridge.ts
  - src/dashboard/spa/live-page/ExerciseHeader.tsx
  - scripts/dashboard-mock-drive.mjs
  - docs/dashboard-drivers.md
  - src/state/auto-arm.ts
  - src/dashboard/spa/live-page/RestView.tsx
lastVerified: 2026-09-30
sourced: 2026-09-30
---

# Your first session

By the end of this you will have opened a session, run at least one set, closed it, and
closed the session — either against a real Voltra or against the mock adapter with no
hardware at all. You will also know the handful of behaviors that surprise people the
first time: the auto-arm gap, the header-weight freeze, and how a guest lifter's sets
stay out of your own history.

You're talking to Claude in English throughout; the tool calls below are what it issues
underneath, named so you can recognize them if you ask Claude to show its work.

## Option A: with a Voltra

Power the device on and wake its screen. The README advises this because a sleeping unit
may not show up in a scan (`README.md`).

1. **"Find my Voltra."** → [`device.scan`](/reference/device) (default 10-second window),
   then [`device.connect`](/reference/device) with the id it found. `device.connect`
   binds the device to a _slot_ — `primary` for one unit, `left`/`right` for two.
2. **"Set it to 60 pounds, weight-training mode."** → `device.set_mode` +
   `device.set_weight`. Confirm the numbers on the device screen match.
3. **"Start a session — I'm doing incline dumbbell press."** →
   [`session.start`](/reference/session). It needs at least one of `exerciseId` (checked
   against the catalog — use [`exercise.search`](/reference/exercise) to find one) or
   `exerciseName` (free text); if you give both, `exerciseId` wins and the name is
   dropped, so give both together only when you're sure they agree
   (`src/schemas/session.ts`). Use `exerciseId` if you plan to attach a plan later.
4. **"Starting my set — stop me at 8 reps."** → [`set.start`](/reference/set), optionally
   with a `watch` block naming a rep count or a velocity-loss percentage to notify on.
   Read that literally: `watch` triggers are advisory cues, not an auto-stop — they fire
   a channel event so Claude can tell you "that's 8" or "you're slowing down," but they
   never end the set on their own. A rep-count trigger used to force-close the set until
   a hardware run tore the cable mid-eccentric (`src/schemas/set.ts`,
   `src/state/event-bridge.ts:1489`). In a normal session a set ends on your own call or on
   the device's own signal. The server also closes it as partial after 90 seconds with no
   activity, and a `watch` block can raise that limit but not lower it
   (`src/state/event-bridge.ts:260-284`). Other paths close a set too, such as
   `session.end` (step 7) and an exit from guided load
   (`src/state/guided-load-reap.ts:58`), so this list is not complete.
   Lift.
   - The set's header weight tracks the unit until your first rep closes, then freezes.
     Arming before you've dialed the weight in still logs what you actually lifted, and a
     weight written mid-set can't retroactively relabel the set — changing the number on
     the unit mid-set is a firmware no-op while the cable is under tension, so the header
     would otherwise name a load nobody lifted (`src/state/event-bridge.ts:1808-1812`).
5. **"Done."** → [`set.end`](/reference/set). This saves the set and its reps with their
   telemetry.
6. Repeat 4–5 per set. For a rest timer, ask for one — Claude uses
   [`timer.start`](/reference/timer), non-blocking, which fires an event when it elapses.
7. **"That's the workout."** → [`session.end`](/reference/session). Any set still open is
   closed as partial.

**Someone working in?** → `session.set_lifter {lifter: 'Jordan'}` before they lift, and
`session.set_lifter {lifter: null}` when you take the rig back. Their sets are recorded
in full but count toward nothing of yours — not your baselines, failure anchors,
progression, or session history. If a set already ran under the wrong name,
`set.update {setId, lifter}` moves it and re-derives your baseline for that exercise
(`README.md`). On the wall dashboard, their name shows next to the exercise name for as
long as they're set as the lifter — the header is yours by default, so a name only
appears while someone else is actually on the cable, and it goes back to showing nothing
extra the moment you clear it.

<!-- src/dashboard/spa/live-page/ExerciseHeader.tsx:222-236 -->

Afterwards: [`session.list`](/reference/session) / `session.get` for history, `set.get`
for one set's full rep detail, [`metrics.compute`](/reference/metrics) for the analytics
pipelines. Keep the [dashboard walkthrough](/guides/dashboard-tour) open in a browser while any of this
happens — it's the same tool pipeline rendered live.

## Option B: without a device

`VOLTRA_ADAPTER=mock` replaces BLE with an in-process device that streams synthetic
telemetry through the same pipeline a real unit uses. The tool surface is identical
(plus `mock.configure` and `mock.inject_error`), so the flow above runs unchanged.

`node scripts/dashboard-mock-drive.mjs` boots the real MCP server in mock mode and
drives it through the real tools — this is what this guide's claims about the mock path
are checked against, not a description of expected behavior. A run against an isolated
database and a non-default dashboard port produced:

```
[drive] scanned: mock-voltra-001 (VTR-Mock)
[drive] connected — mock telemetry streaming
[drive] session.start | rev=1 session=Cable Chest Press activeSet=none
[drive] set 1 start   | rev=2 session=Cable Chest Press activeSet=#? reps=1
[drive] set 1 mid     | rev=3 session=Cable Chest Press activeSet=#? reps=3
[drive] set 1 end     | rev=4 session=Cable Chest Press activeSet=none
[drive] set 2 start   | rev=5 session=Cable Chest Press activeSet=#? reps=0
[drive] set 2 mid     | rev=6 session=Cable Chest Press activeSet=#? reps=2
[drive] set 2 end     | rev=7 session=Cable Chest Press activeSet=none
[drive] set 3 start   | rev=8 session=Cable Chest Press activeSet=#? reps=0
[drive] set 3 mid     | rev=9 session=Cable Chest Press activeSet=#? reps=2
[drive] set 3 end     | rev=10 session=Cable Chest Press activeSet=none
[drive] session.end | rev=11 session=none activeSet=none
[drive] workout complete: 3 sets driven through the real pipeline
```

The `mid` line per set shows reps accruing from mock telemetry. The `start` and `end` lines
mark the set boundary.

`device.scan` → `device.connect` → `session.start` → (`set.start` → `set.end`) × 3 →
`session.end` — the same call sequence as Option A, just with no BLE underneath.

Open `http://127.0.0.1:<port>/app` before or during the run: while the session is open the
snapshot carries its finished sets, so a late page rebuilds its set log from them. The driver
ends the session when the workout finishes, after which there is nothing to rebuild. `dashboard-mock-drive` takes `VMCP_DASHBOARD_PORT=`; see the driver's
own header comment for the rest. It starts a bare single-exercise session with no plan
attached — for the planned path, see
[the planned-session guide](/guides/planned-session)
([`docs/dashboard-drivers.md`](https://github.com/HJewkes/voltras-mcp/blob/main/docs/dashboard-drivers.md)).

## Auto-arm: sets that open themselves

`VMCP_AUTO_ARM` is `on` by default. Reps start within about a second of a weight change
on the unit, and a model round-trip to call `set.start` is slower than that — so on an
open session with no set open, the server opens one itself once it sees reps, and the rep
that triggered it is _not_ dropped. It waits for a second rep to agree with the first
before adopting either, because a single rope-positioning pull looks exactly like
a rep until another rep disagrees with it (`src/state/auto-arm.ts`, VW-164/VW-181). If
you didn't call `set.start` yourself and a set appears anyway, this is why. It isn't a
bug, and the reps that opened the set are counted in it. The wall dashboard marks such a set with a
compact "AUTO" badge on the live header while it's active. The rest recap shows the same
label once it closes, unless the set has a warm-up, probe or technique label instead
(`src/dashboard/spa/live-page/RestView.tsx`).

## Set purpose

`set.start` takes an optional `setPurpose`: `working`, `warmup`, `probe`, or `technique`
(`src/schemas/set.ts`). Omit it and you get `working`, the default. The device can't infer
it, because a warm-up, a probe and a working set look identical to the hardware. It decides
whether progression scores the set.

## Check-in at the end of a session

[`session.end`](/reference/session) takes an optional `checkin` block, recorded atomically
with the close — or call [`session.checkin`](/reference/session) on its own at any point
against the active session. Omit it and nothing is asked; it's never a gate on ending a
session.

The question set comes from RP's client check-in: four free-text prompts — how it went,
how you felt, whether anything felt off, and any questions — plus four questions on RP's
coarse 3-point scale (`low`/`medium`/`high`, never a 5- or 10-point scale): how you're
feeling about the next session or week, soreness, joint discomfort, and motivation. The
tool tells Claude not to ask "How did it go?", because completion (loads, reps, sets) is
already in the telemetry. Claude should show you your own numbers back instead, and that
answer exists only to store whatever you volunteer (`src/tools/session-tools.ts`). Of the four 3-point
questions, soreness, joint discomfort, and motivation are withheld entirely until you have
trained on an earlier day: every session of your first training day skips them, since that
early the answers are uniformly positive and
asking can seed unwarranted concern — RP's cadence otherwise is after the very first
session, then at the end of every completed week.

A guest session — one running under [`session.set_lifter`](/reference/session) — writes no
check-in at all: it's the owner's alone.

## What to read next

- The [dashboard walkthrough](/guides/dashboard-tour) shows the same lifecycle rendered live, stage by
  stage, including the rest countdown and the session summary.
- [The planned-session guide](/guides/planned-session) covers running against a
  prescribed plan instead of free-lifting.
- The [tool reference](/reference/) has full schemas for every tool named above.
