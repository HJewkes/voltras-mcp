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

## What to read next

- The [dashboard walkthrough](/guides/) for the diverging stage rendered live.
- [The isometric guide](/guides/isometric) for `isometric.measure_imbalance`, which runs
  the same left/right slot pairing to compare force between sides.
- The [`bilateral.*`](/reference/bilateral), [`slot.*`](/reference/slot) and
  [`device.*`](/reference/device) references for full schemas.
