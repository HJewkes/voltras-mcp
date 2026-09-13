# Bilateral work

A bilateral rig is two Voltras, one per side, tracked as independent
[slots](/reference/slot): `left` and `right`, instead of the single `primary` slot a
one-device session uses (`README.md:210-212`). Everything downstream — telemetry, sets,
push events, the dashboard — keys off which slot a rep came from, so the two sides never
get mixed into one stream.

This assumes the [first-session guide](/guides/first-session) already; a bilateral
session is the same `session.*`/`set.*` lifecycle running twice, once per slot.

## Connecting and identifying two units

[`device.connect`](/reference/device) binds a device to a slot the same way it does for
one unit — call it twice, once with `slot: 'left'` and once with `slot: 'right'`
(`README.md:210-212`).

Two Voltras look identical on the table, so [`slot.identify`](/reference/slot) exists to
answer "which one is which": it briefly switches the named slot's device into Damper mode
— the screen visibly changes — then reverts it to whatever mode it was in
(`src/tools/slot-tools.ts:93-99`). Watch which physical unit's display changes and you
know which slot it's bound to.

Once you've confirmed a side, [`slot.bind`](/reference/slot) persists the deviceId ↔
`left`/`right` mapping to `~/.voltras/slot-bindings.json`
(`VMCP_SLOT_BINDINGS_PATH`, `src/tools/slot-tools.ts:101-106`), so a later
`device.connect {slot: 'auto'}` against the same device routes it to the same side
without repeating the identify ritual. [`slot.bindings_list`](/reference/slot) shows what's
persisted, and [`slot.unbind`](/reference/slot) removes an entry. [`slot.swap`](/reference/slot)
swaps the two connected slots' bindings in place with no BLE traffic at all.

## Setting both units at once: `bilateral.cascade`

[`bilateral.cascade`](/reference/bilateral) applies mode, weight, eccentric overload and
chains across one or more bound slots in a single call. It's a full-settings contract, not
a partial patch: every call must supply all four fields, or the tool rejects it with
`INVALID_INPUT` naming what's missing — a partial cascade would leave the omitted settings
at their prior firmware value, which is exactly the kind of stale state this tool exists to
avoid (`src/tools/device-tools.ts:251-258`).

### Why the mode write goes first

Within a slot, the mode setter no longer races the other three. It used to: all four
setters fired concurrently, and on 2026-09-07 that produced a real failure on hardware —
requesting Isokinetic mode across two bound slots left one unit in Weight Training and the
other in Idle, twice, while calling `device.set_mode` alone stuck every time. The weight,
eccentric and chains writes racing the mode change were making the firmware fall back
(`src/state/bilateral-cascade.ts:11-22`, `src/tools/device-tools.ts:254`, VW-162).

The fix: when the requested mode differs from what the device currently echoes, the mode
write goes out alone first, and the cascade waits for the device's mode echo before firing
weight/eccentric/chains on that slot. Each `results[i]` reports how that wait resolved in
its `modeEcho` field:

- `confirmed` — the device echoed the new mode; `echoedAfterMs` says how long that took.
- `skipped` — no mode was requested, or the device was already in the requested mode, so
  there was nothing to wait for.
- `timeout` — the echo didn't arrive in time. The slot's other setters are **not** issued;
  re-issue `device.set_mode` for that slot and check `device.get_state` before retrying
  (`src/tools/device-tools.ts:255`).

The wait is bounded by `MODE_REVERT_WINDOW_MS` — 2000ms — the same window the mode-revert
guard itself uses to keep evaluating divergence, so a longer wait would report a
confirmation the safety guard no longer stands behind
(`src/state/mode-revert-guard.ts:40`, `src/state/bilateral-cascade.ts:57-64`).

**Where this stands:** the reordering is merged and covered by tests, including one that
exercises the echo wait directly (`src/tools/__tests__/bilateral-cascade.test.ts:576`,
`VW-162: waits on the slot mode-revert guard and reports the echo`). It has not yet been
re-run against two physical units — the original failure that motivated the fix was a
hardware observation, and the fix itself is confirmed in tests, not on a bench, as of this
writing.

Slots still run concurrently with each other, so a failure or a timeout on one slot doesn't
block the other. With `abortOnFirstFailure: true`, setters within a slot run sequentially
instead, and the first rejection anywhere stops every setter not yet issued
(`src/tools/device-tools.ts:256`).

## Reading per-slot events

Most push events carry a `slot` meta key: `primary` for a single-device flow, `left` /
`right` when two units are connected, so a coaching surface can filter on it to keep the
two rep streams apart. Every event also carries an `at` meta key — an ISO-8601 UTC
timestamp of when the server emitted the push
(`docs/push-events.md:40-46`). A handful of events never carry `slot` at all (global things
like `timer_complete`), and two carry slot information under different keys
(`slot_id`/`partner_slot_id` on `bilateral_divergence`) — see
[the full breakdown](https://github.com/HJewkes/voltras-mcp/blob/main/docs/push-events.md)
if you're filtering programmatically.

If a cascade stops partway because another client took the write lease, the
`lease_lost` event names both the tool and the slot it stopped on
(`docs/push-events.md:381-412`).

## Watching it on the dashboard

The live page picks its stage from state: the diverging two-column stage renders only when
**both** limb slots — `left` and `right` — are bound. One bound limb, or none, falls back
to the single stage, because an ordinary one-device session running on `primary` would
otherwise draw an empty second column
(`src/dashboard/spa/live-page/stage-variant.ts:10-20`). `?variant=live-dual` (or
`?variant=live`) on the dashboard URL pins one or the other for testing
(`README.md:280-281`). See the ["Two Voltras, one dashboard"](/guides/#two-voltras-one-dashboard)
capture in the walkthrough for what the diverging stage actually looks like mid-set.

Here it is moving. The right side starts late and finishes short, so the gap between the
two columns opens while the set is still running, and each side closes on its own reps
before the page falls through to rest. Recorded headlessly from two synthetic devices
through the real tool pipeline — no hardware, and the asymmetry is scripted rather than
lifted from anyone's training.

<video controls preload="metadata" width="100%" src="/captures/clips/dual-divergence.mp4" title="Two Voltras on the left and right slots diverging through a set, then falling through to rest."></video>

The narration is synthetic speech, generated from a script in this repository. Edit
[`dual-divergence.narration.txt`](https://github.com/HJewkes/voltras-mcp/blob/main/site/guides/dual-divergence.narration.txt)
and re-run `npm run docs:captures` to change what it says
([`docs/screenshot-harness.md`](https://github.com/HJewkes/voltras-mcp/blob/main/docs/screenshot-harness.md)).

## No hardware, or only one device: the dual mock path

`node scripts/dashboard-mock-drive.mjs --dual` drives two slots through the real MCP tool
pipeline with no hardware at all. Stock mock mode only advertises one synthetic device, so
`--dual` boots the server with `scripts/mock-two-slot-preload.mjs` imported, which makes the
mock's scan return two devices and gives each dialled slot its own independent telemetry
generator — real rep isolation, not one stream mirrored into two slots
(`scripts/mock-two-slot-preload.mjs:1-26`, `scripts/dashboard-mock-drive.mjs:28-36`).

Asymmetry is the point of the driver, so it takes flags to make the two sides diverge on
purpose rather than mirror each other:

- `--reps=left:N,right:N` — per-slot target reps for each set (default 5 each)
- `--lag=right:ms` — that slot starts each set N ms late
- `--stall=right@N` / `--stall-ms=ms` — freeze that slot's telemetry mid-set on set N

(`scripts/dashboard-mock-drive.mjs:41-50`)

A run against an isolated database and a non-default dashboard port, with the right side
running fewer reps and starting late:

```
VMCP_DB_PATH=/tmp/vmcp-dual-verbatim.sqlite node scripts/dashboard-mock-drive.mjs --dual \
  --reps=left:6,right:4 --lag=right:2500 --port=7793 --control-port=7792

[drive] MCP initialized; waiting for handlers + dashboard bind…
[drive] dashboard at http://127.0.0.1:7793/app  (open it now)
[drive] slot left ← mock-voltra-left (mock telemetry streaming)
[drive] slot right ← mock-voltra-right (mock telemetry streaming)
[drive] sessions started | rev=1 reps left=— right=—
[drive] set 1 left: started (target 6 reps)
[drive] set 1 right: started (target 4 reps)
[drive] set 1 right: ended at 4 reps
[drive] set 1 left: ended at 6 reps
[drive] set 1 done    | rev=77 reps left=— right=—
[drive] set 1: left=6 right=4
[drive] set 2 left: started (target 6 reps)
[drive] set 2 right: started (target 4 reps)
[drive] set 2 right: ended at 4 reps
[drive] set 2 left: ended at 6 reps
[drive] set 2 done    | rev=124 reps left=— right=4
[drive] set 2: left=6 right=4
[drive] set 3 left: started (target 6 reps)
[drive] set 3 right: started (target 4 reps)
[drive] set 3 right: ended at 6 reps
[drive] set 3 left: ended at 6 reps
[drive] set 3 done    | rev=164 reps left=— right=4
[drive] set 3: left=6 right=6
[drive] sessions ended  | rev=165 reps left=— right=—
[drive] dual workout complete: 3 sets × 2 slots through the real pipeline
```

This is the run's complete, unedited output — nothing trimmed. Both slots connected, ran
independent sets, and closed independently; the `set N done | rev=… reps left=… right=…`
lines are the per-slot rep counts landing separately, which is the actual evidence the two
rep streams stayed apart rather than mirroring each other. Open `http://127.0.0.1:<port>/app`
before or during the run, same as the single-slot driver — the set log accumulates
client-side from live transitions.

## What a detected asymmetry does not license

Two statements hold across every tool in this server, and neither is a style preference.

**No corrective unilateral work is prescribed from an asymmetry.** Not by
`coaching.explain`, not by `plan.suggest_progression`, not by
`isometric.measure_imbalance`. The intervention literature does not support it: meta-analysed
against bilateral training, unilateral training was clearly better for unilateral jump
(ES 0.89, 95% CI 0.52-1.26) and worse for bilateral strength (ES -0.43, CI -0.71 to -0.14),
while unilateral strength, bilateral jump, sprint and change of direction were all
non-significant (Liao et al., *Biology of Sport* 2022). Unilateral work is goal-specific —
prescribe it when single-limb capacity is the goal. The evidence that any method reduces
asymmetry at all is thin: a seven-week bilateral back-squat block moved isometric peak-force
asymmetry only in the subgroup that started weaker, and several combined and flywheel
programmes improved performance while leaving asymmetry untouched (Bishop et al. 2023). The
authors' own recommendation for a detected asymmetry is consistent strength training over
time, and an athlete showing only natural between-session fluctuation in limb dominance may
need no intervention at all.

**A load derived from an isometric maximum is a heuristic.** `isometric.measure_max` and
`isometric.measure_imbalance` both return an inferred working weight at 70% of the mean
plateau force, and both label it as such in the result itself, not only in the description
(`src/tools/isometric-tools.ts:278-294`). No study validates a cable-device isometric maximum
as a predictor of dynamic cable loads, and no `plan.*` or `progression.*` path consumes one.
Joint angle dominates what an isometric maximum predicts: an isometric squat predicted the
full squat at r 0.864 at 90 degrees of knee flexion but only r 0.597 at 120 degrees (Lum et
al., *Sports* 2020), so the figure means something only when the hold was held at the angle
where the exercise peaks.

There is **no published re-test cadence** for asymmetry, and this server invents none. The
defensible rule is a decision rule, not an interval: test often enough to judge whether limb
dominance is consistent across sessions.

## What to read next

- The [dashboard walkthrough](/guides/) for the diverging stage rendered live.
- [The isometric guide](/guides/isometric) for `isometric.measure_imbalance`, which runs
  the same left/right slot pairing to compare force between sides.
- The [`bilateral.*`](/reference/bilateral), [`slot.*`](/reference/slot) and
  [`device.*`](/reference/device) references for full schemas.

## Setup geometry gates the asymmetry verdict

Two units at the same commanded weight are not two units at the same joint demand. A
cable's resistance torque is the force times the perpendicular distance from the line of
the cable to the joint, and that line moves when the anchor moves — so the resistance
moment arm, and with it the shape of the load through the range, is a property of where
the cable is attached rather than of the number on the device. Keogh, Lake & Swinton
(2013, _Journal of Fitness Research_ 2(2):39-48) work the example: a cable lateral raise
peaks its moment arm near full adduction and _decreases_ through the concentric, while the
dumbbell version peaks at 90 degrees. Same load, different torque curve.

The consequence for a two-unit rig is blunt: left and right anchored at different heights
will manufacture a left/right difference that has nothing to do with the athlete. So every
left-vs-right comparison here is gated on geometry first.

The signature each side is compared on is its median concentric cable travel over the reps
that count as work — the same observable the setup clustering
([`exercise.confirm_setup`](/reference/exercise)) reads. Two sides more than 1.15x apart
are a geometry mismatch, the same band a single side's sets have to cross before they are
judged a new setup.

- On the wall, the `L/R` callout under the diverging stage is replaced by the reason it
  was held back. You get a sentence, not a blank space.
- In [`progression.get_for_exercise`](/reference/progression), `sideSplit` carries
  `setupComparability`. On `setup_confounded` it also carries `setupSignatures` (both
  sides' travel medians) and `setupReason`; the per-side set counts and top loads still
  ship, because those are facts about one side each — what is withheld is reading the gap
  between them as an imbalance.
- `setup_unverified` means a side recorded no measurable travel, so the check never ran.
  That is not a mismatch, and it does not withhold anything.

If the verdict comes back `setup_confounded`, fix the rig rather than the lifter: match
the anchor height and cable-length setting on both units, then re-run the comparison.
