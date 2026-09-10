# Your first session

By the end of this you will have opened a session, run at least one set, closed it, and
closed the session — either against a real Voltra or against the mock adapter with no
hardware at all. You will also know the handful of behaviors that surprise people the
first time: the auto-arm gap, the header-weight freeze, and how a guest lifter's sets
stay out of your own history.

You're talking to Claude in English throughout; the tool calls below are what it issues
underneath, named so you can recognize them if you ask Claude to show its work.

## Option A: with a Voltra

Power the device on and wake its screen — a sleeping unit doesn't advertise
(`README.md`).

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
   a hardware run tore the cable mid-eccentric; the set now always ends on your own call
   or the device's own signal (`src/schemas/set.ts`, `src/state/event-bridge.ts:1451`).
   Lift.
   - The set's header weight tracks the unit until your first rep closes, then freezes.
     Arming before you've dialed the weight in still logs what you actually lifted, and a
     weight written mid-set can't retroactively relabel the set — changing the number on
     the unit mid-set is a firmware no-op while the cable is under tension, so the header
     would otherwise name a load nobody lifted (`src/state/event-bridge.ts:1756-1760`).
5. **"Done."** → [`set.end`](/reference/set). This persists the set and every rep with
   its telemetry.
6. Repeat 4–5 per set. For a rest timer, ask for one — Claude uses
   [`timer.start`](/reference/timer), non-blocking, which fires an event when it elapses.
7. **"That's the workout."** → [`session.end`](/reference/session). Any set still open is
   closed as partial.

**Someone working in?** → `session.set_lifter {lifter: 'Jordan'}` before they lift, and
`session.set_lifter {lifter: null}` when you take the rig back. Their sets are recorded
in full but count toward nothing of yours — not your baselines, failure anchors,
progression, or session history. If a set already ran under the wrong name,
`set.update {setId, lifter}` moves it and re-derives your baseline for that exercise
(`README.md`).

Afterwards: [`session.list`](/reference/session) / `session.get` for history, `set.get`
for one set's full rep detail, [`metrics.compute`](/reference/metrics) for the analytics
pipelines. Keep the [dashboard walkthrough](/guides/) open in a browser while any of this
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
[drive] set 1 end     | rev=4 session=Cable Chest Press activeSet=none
[drive] set 2 start   | rev=5 session=Cable Chest Press activeSet=#? reps=0
[drive] set 2 end     | rev=7 session=Cable Chest Press activeSet=none
[drive] set 3 start   | rev=8 session=Cable Chest Press activeSet=#? reps=0
[drive] set 3 end     | rev=10 session=Cable Chest Press activeSet=none
[drive] session.end | rev=11 session=none activeSet=none
[drive] workout complete: 3 sets driven through the real pipeline
```

`device.scan` → `device.connect` → `session.start` → (`set.start` → `set.end`) × 3 →
`session.end` — the same call sequence as Option A, just with no BLE underneath.

Open `http://127.0.0.1:<port>/app` before or during the run: the set log accumulates
client-side from live transitions, so a browser that connects after the last set has
nothing to show. `dashboard-mock-drive` takes `VMCP_DASHBOARD_PORT=`; see the driver's
own header comment for the rest. It starts a bare single-exercise session with no plan
attached — for the planned path, see
[the planned-session guide](/guides/planned-session)
([`docs/dashboard-drivers.md`](https://github.com/HJewkes/voltras-mcp/blob/main/docs/dashboard-drivers.md)).

## Auto-arm: sets that open themselves

`VMCP_AUTO_ARM` is `on` by default. Reps start within about a second of a weight change
on the unit, and a model round-trip to call `set.start` is slower than that — so on an
open session with no set open, the server opens one itself the moment it sees a rep, and
the rep that triggered it is _not_ dropped. It waits for a second rep to agree with the
first before adopting either, because a single rope-positioning pull looks exactly like
a rep until another rep disagrees with it (`src/state/auto-arm.ts`, VW-164/VW-181). If
you didn't call `set.start` yourself and a set appears anyway, this is why — it isn't a
bug, and the rep count is still accurate.

## Set purpose

`set.start` takes an optional `setPurpose`: `working`, `warmup`, `probe`, or `technique`
(`src/schemas/set.ts`). Omit it and you get `working`, the default. This is the one
piece of set-level intent the device can't infer on its own — a warm-up, a probe, and a
working set look identical to the hardware — and it decides whether the set counts toward
progression.

## What to read next

- The [dashboard walkthrough](/guides/) shows the same lifecycle rendered live, stage by
  stage, including the rest countdown and the session summary.
- [The planned-session guide](/guides/planned-session) covers running against a
  prescribed plan instead of free-lifting.
- The [tool reference](/reference/) has full schemas for every tool named above.
