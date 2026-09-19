# Recovery and escalation

**When to read this.** A setter returned ok but the device shows the wrong value; OR `set.start` refuses; OR a setter refuses with `DEVICE_STATE_UNKNOWN`; OR a connect is refused; OR a stop or unload came back `unconfirmed`; OR a write tool returns a lease error; OR a slot disconnected mid-session; OR the MCP is unresponsive; OR the user wants to switch from "let's lift" to "let's debug."

The cardinal rule when something goes wrong: **stop the user before they lift.** Wrong-load incidents are the highest-impact failure. Everything else is recoverable from a paused state.

## The escalation ladder

```
Level 0:  Setter ok + verify ok                              → proceed
Level 1:  Setter ok + verify mismatch                        → re-issue the diff (single setter), re-verify
Level 2:  Two mismatches on the same slot                    → stop the user; have them read the screen
Level 3:  Screen disagrees with get_state                    → stale link → reconnect that slot
Level 4:  Setter ok but no settings_update arrives           → the write never landed → reconnect, don't retry
Level 5:  Reconnects keep failing                            → power-cycle the Voltra
Level 6:  Power-cycle doesn't help                           → MCP-side → /mcp reconnect or restart Claude Code
Level 7:  3 cascade-and-verify cycles failed                 → stop the workout; debug mode or end the session
```

Step through it. The user's patience for "trust me, lift it" ends at Level 2.

## Tool inventory for recovery

| Tool                                                                                    | What it does                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.get_state {slot}`                                                               | The verification read, plus `state_confirmed`, `connectionState`, `load_state`, `guided_load.phase`, `mode_revert_latched` when an abort is pending, and `disconnect_notice` once after a drop           |
| `device.unload {slot}`                                                                  | Release the cable. Idempotent, also exits an active guided load. **Read `read_back.verdict`**                                                                                                            |
| `device.exit_guided_load {slot}`                                                        | Leave a guided load. Its read-back is always `unconfirmed`                                                                                                                                               |
| `device.set_mode {slot, mode: "WeightTraining"}`                                        | The recovery for a device stuck in Damper or Idle                                                                                                                                                        |
| `system.lease_status` / `lease_acquire {force?, acceptLoadedDevice?}` / `lease_release` | Who holds the device, take it, give it back                                                                                                                                                              |
| `device.disconnect {slot}`                                                              | Drop the link. Does not drop the load, and does not close an open set or session                                                                                                                         |
| `debug.recent_events {types?}`                                                          | The server's diagnostic ring buffer: rep and set boundaries, settings updates, connection changes, guided-load states. These are internal names, not channel event names. `setting_coerced` is not in it |
| `debug.compare_rep_streams {slot}`                                                      | Analytics vs device rep count on the active set                                                                                                                                                          |
| `debug.recording_status`                                                                | Whether the opt-in flight recorder is capturing                                                                                                                                                          |
| `debug.recent_frames` / `device.send_raw {confirm: true}`                               | Low-level capture and write. Debug mode only, on the user's explicit request. **Never quote their content** in chat, notes, tasks or commits                                                             |
| `server.health`                                                                         | Adapter, lease holder, channel status, cues, voice readiness                                                                                                                                             |

## Failure modes

### Mode A — setter ok, verify mismatch

```
bilateral.cascade {weightLbs: 30, …} → applied ok
device.get_state → weightLbs: 200                       ← MISMATCH
```

1. Re-issue only the diff: `device.set_weight {slot, lbs: 30}`. Never a partial cascade.
2. Re-verify.
3. Still wrong: Mode B. Budget: 2 attempts.

Check `results[i].modeEcho` first. `timeout` means that slot failed and its weight, eccentric and chains were **never issued**. Re-issue `device.set_mode` for that slot, read `get_state`, then retry.

### Mode B — two mismatches on one slot

```
system.speak {interrupt: true, text: "Stop. Don't lift. Fixing the load."}
"The cable says X and I asked for Y. Read me the screen."
Screen says X  → Mode C (stale link)
Screen says Y  → get_state is stale; one more cascade-and-verify; if it now reads Y, proceed; else Mode C
```

### Mode C — stale link (write reported ok, the device didn't apply it)

`settings_update` should follow an accepted write within about 100 ms. If it doesn't, or `get_state` keeps the old value, the link is wedged. **Another write does not fix a stale link.**

1. Stop the user (Mode B phrasing).
2. `set.end {slot}` if a set is open (zero reps is fine). `session.end {slot}` too if you are about to disconnect.
3. `debug.recent_events {types: ["settings_update"]}`: no entry with your value means the write never reached the device.
4. `device.disconnect {slot}`, or ask the user to power-cycle the unit if disconnect hangs.
5. `device.scan` again (connect only knows the last scan), `device.connect {slot: "auto"}`, `system.lease_acquire`.
6. Wait for `state_confirmed: true`. Re-cascade. Verify.

### Mode D — `setting_coerced` (not a failure)

A deliberate clamp by the device. Don't retry; tell the user; update your intent. Eccentric coercion needs two matching observations before it fires; weight, chains, damper and assist fire at once. Mode-config setters (isokinetic, band, damper, assist) get no echo, so their coercions never fire; the screen is the check.

### Mode E — `SET_ABORTED_BY_MODE_REVERT` (VW-163)

`set.start` refuses, the motor does not engage, and `get_state` shows `mode_revert_latched: {requested_mode, actual_mode, timestamp_ms}`. The guard latched because the device reported a different mode than the one armed at `session.start` or the last `set.start`. The usual trigger: a non-WeightTraining mode sent through `bilateral.cascade` (VW-162, open).

The error text says re-issuing the mode setter auto-clears the latch when the device echoes the requested mode. On 2026-09-07 that did not clear it. Recovery that worked every time:

```
device.get_state {slot}                          # confirm active_mode is what you want; fix with device.set_mode if not
device.set_mode {slot, mode: <wanted>}           # one attempt at the documented auto-clear
set.start {slot, …}                              # if it still refuses:
session.end {slot}                               # clears the latch (also on session.start)
session.start {exerciseId, slot}                 # same exercise id
plan.attach_to_session {sessionId: <new>, …}     # re-attach if on a program
set.start {slot, …}
```

Do not lift until `set.start` returns a `setId`; the guard is a safety feature and the motor really is not engaged.

### Mode F — lease errors

| Code                                         | Meaning                                                                                                                                                                      | Do                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `LEASE_HELD`                                 | Another client holds the lease; device idle                                                                                                                                  | `system.lease_status`; if the holder is stale (old `lastActivityAt`), `system.lease_acquire {force: true}` with the user's ok |
| `LEASE_HELD_ENGAGED`                         | Another client is driving the device right now                                                                                                                               | Stop. Ask who else is connected. Only force with the user's explicit ok; the steal unloads their cable                        |
| `LEASE_TRANSFERRING`                         | A handover is mid-flight                                                                                                                                                     | Retry in a moment                                                                                                             |
| `LEASE_LOST`, or a `lease_lost` event        | Your multi-step call stopped partway because another client took the lease. A blocked hold or `timer.wait` rejects the same way; an aborted isometric hold unloads the cable | The remaining writes did NOT go out. `system.lease_acquire`, then re-issue the WHOLE call, never just the tail                |
| `acquired: false`, cable may still be loaded | The steal could not confirm any slot unloaded                                                                                                                                | Do not pass `acceptLoadedDevice: true` unless the user confirms nobody is on the machine                                      |

If someone is under load and you cannot get the lease, unload first, argue later.

### Mode G — guided load stuck

- `GUIDED_LOAD_MODE_MISMATCH`: the unit is not in WeightTraining. Nothing was written. Tell the user which mode it is in. Ask before you switch it (or pass `autoSwitchMode: true` on their word).
- `guided_load_state` phase `timeout`: usually nobody extended the cable. Ask.
- `GUIDED_LOAD_NOT_ARMED`: after the trigger the phase was outside the active set. Treat as not started. `device.unload`, verify, retry once.
- Phase `active` straight away, or `ceremony_skipped: true`: the ceremony was skipped. Check the first `rep_finalized`. If nothing engages, `device.unload` and re-trigger.
- `GUIDED_LOAD_EXIT_UNCONFIRMED`, or any doubt after an exit: `device.unload` is the release the device confirms. Use it.

### Mode H — a stop or unload came back `unconfirmed`

`device.unload → read_back.verdict: "unconfirmed"`, a `deterministic_stop_triggered` event whose content carries `release: "unconfirmed"`, the spoken reply "Stopping. Check the cable, the weight may still be on", or the error `UNLOAD_UNCONFIRMED`. All mean the same thing: **the device did not report the release. Treat the cable as loaded.**

1. Tell the lifter to keep clear of the handle.
2. `device.unload {slot}` again. Read the verdict.
3. Ask them to confirm by eye that the cable is slack before anyone loads it.
4. `load_state: "unloaded"` proves nothing; it reads that way during ordinary reps.

### Mode I — `set.start` or a setter refuses for other reasons

| Error                                             | Diagnosis                                                                                                            | Recipe                                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DEVICE_STATE_UNKNOWN`                            | The device has not reported its settings on this connection yet                                                      | Wait a moment, `device.get_state` until `state_confirmed: true`, retry. Stops are never held back             |
| `CONNECTION_REFUSED`                              | The lifter did not accept the connection on the device, or it timed out (up to 30 s)                                 | Ask them to accept on the device, then `device.connect` again. It is never retried for you                    |
| `DEVICE_NOT_FOUND` on connect                     | The device is not in the most recent scan                                                                            | `device.scan`, then connect                                                                                   |
| `SLOT_NOT_BOUND`                                  | Slot not connected, or you defaulted to `primary` on a bilateral rig                                                 | Pass the right `slot`; else scan and connect                                                                  |
| `NO_ACTIVE_SESSION`                               | No `session.start` on this slot                                                                                      | `session.start {exerciseId, slot}`                                                                            |
| `SET_ALREADY_ACTIVE`                              | A set is open and it is not an auto-armed set awaiting its one upgrade                                               | `set.end {slot}` then retry                                                                                   |
| `ROWING_USE_TWO_STAGE`                            | Device is in Rowing                                                                                                  | `device.set_mode {mode: "WeightTraining"}` for strength work, or `device.enter_row_mode` + `device.start_row` |
| `INVALID_INPUT` on `set.start`                    | A velocity-loss watch with no `pct`, no `intent` and no planned intent; or `setPurpose` and `isWarmup` that disagree | Fix the call                                                                                                  |
| `INVALID_INPUT` on an eccentric or isometric call | The peak would exceed the configured mount rating                                                                    | Do not work around it. Lower the load or skip it                                                              |
| `BUSY` / `STARTING`                               | Transient                                                                                                            | Wait 1 to 2 s, retry once, then Mode C                                                                        |

### Mode J — the MCP is unresponsive, or tools are missing

Symptoms: timeouts, `Connection closed`, `No such tool available`.

1. Don't burn turns retrying.
2. Use the time: collect the remaining workout params, coach setup, pull `session.list` if reads survive.
3. Wait for the user's explicit "reconnected."
4. After reconnect: in-memory slot state and the lease are gone; persisted bindings survive. Rescan, `connect {slot: "auto"}`, `lease_acquire`, `server.health`. The active set was lost; start fresh.

A different case: the server answers but **newer tools are missing** (`plan.current_block`, `plan.block.schedule`). That is an old server build, not a fault. Say so; the restart is the owner's step (`14`, preflight).

### Mode K — the dashboard is missing

`server.health.dashboardAvailable: false`. If `dashboardDisabledReason` is `"disabled"`, it was turned off on purpose; say nothing more. With a null reason on a machine that normally has one, another voltras-mcp process probably holds the port. Tell the user; they can stop the stale process and `/mcp` reconnect. Not a workout blocker.

### Mode L — voice is not working

`server.health.voiceReady.whisperCli` or `.model` false means speech will not transcribe at all. Say so and fall back to typed input. And remember the standing limit: the mic is deaf while any spoken line plays, safety phrases included (VW-173, open). Never rely on a spoken "stop" during a cue.

## The 3-cascade-and-verify budget

After 3 failed cascade-and-verify cycles, stop the workout flow. Either pivot to debug mode or `session.end` + `system.lease_release` + `device.disconnect` and tell the user to come back after the issue is investigated. Continued attempts erode trust faster than a clean stop.

## Pivoting to debug mode

Signals: "let's debug," "what's going on," "are we getting cross-talk," a proposed controlled test.

1. Drop the trainer voice. No `system.speak` cues.
2. No new `session.start` / `set.start` loops.
3. Diagnostic toolkit: `debug.recent_events {types}`, `debug.compare_rep_streams`, `debug.recording_status`, `device.get_state`, `server.health`. `debug.recent_frames` and `device.send_raw {confirm: true}` only on the user's request.
4. Say it: "We're in debug mode now."
5. `setting_coerced` is not in the ring buffer; watch for it inline.
6. Capture findings so they outlive the session (an active-work task or note). **Describe behaviour in plain words. Never paste low-level capture content into a note, task, commit or chat.**

## Pitfalls

- **Don't retry a stale write.** Reconnect first.
- **Don't soften a failure.** "The cable says 200, I asked for 30. Stopping." Truth beats bedside manner.
- **Don't skip the screen read at Level 2.** The screen is ground truth.
- **Don't treat `unconfirmed` as fine.**
- **Don't keep coaching during recovery.** Shorter, technical, fewer adjectives.
- **Don't force-steal a lease casually.** It unloads someone else's cable.
- **Don't use `device.disconnect` to release a load.** `device.unload` releases; disconnect only drops the link.
- **Don't re-issue only the tail after a lost lease.**

## Cross-refs

- Verify rules, the mode rule, read-back verdicts: `02-setter-cascade-and-verification.md`
- Reconnect flows and lease at connect: `01-discovery-and-connection.md`
- Event payloads for `set_aborted_by_mode_revert`, `connection_changed`, `setting_coerced`, `lease_lost`: `08-channel-events-reference.md`
- Resuming the workout: `04-set-execution.md`
