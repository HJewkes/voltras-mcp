# Discovery and connection

**When to read this.** A session is starting and you need one or two Voltras connected, the device lease, and the dashboard URL; OR a device dropped mid-session; OR the user asks "is my Voltra connected?" / "find my second cable" / "which side is which?".

Three things happen in this phase beyond scan and connect: take the **lease** explicitly, call **`server.health`** for the dashboard URL and cue state, and check the **profile gaps**. All three are one call each.

## Tool inventory

| Tool                                                  | What it does                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device.scan {timeoutMs?}`                            | One-shot active scan, default 10 s, and the call blocks for it. Returns the nearby Voltras as `devices` with `deviceId`                                                                                                                                                                                                           |
| `device.set_passive_scan {enabled, intervalSeconds?}` | Background scanner (5..600 s cadence, off at server start) that fires `voltras_available` for newly-seen devices. Skips its scan window whenever any slot is connected                                                                                                                                                            |
| `device.connect {deviceId, slot?}`                    | Bind a slot to a device. `slot` is `primary` (default), `left`, `right`, or `'auto'`. `'auto'` resolves from the persisted binding and returns `NO_PERSISTED_BINDING` when there is none; then pass an explicit side and run the ritual. It looks `deviceId` up in the MOST RECENT scan only: `DEVICE_NOT_FOUND` means scan again |
| `device.disconnect {slot}`                            | Drop the link for a slot. It first tries to return the device to its home screen. It does NOT close an open set or session, and it does not release a load                                                                                                                                                                        |
| `system.lease_acquire {force?, acceptLoadedDevice?}`  | Take the single-writer device lease. Acquired implicitly on your first write call anyway; calling it explicitly surfaces contention before the user is at the cable. `force: true` unloads the other client's device and steals; only with the user's say-so                                                                      |
| `system.lease_status`                                 | Who holds the lease and whether it is you. `generation` rises every time it changes hands                                                                                                                                                                                                                                         |
| `system.lease_release`                                | Release; unloads first if anything is still engaged                                                                                                                                                                                                                                                                               |
| `server.health`                                       | Version, build (may read "unknown"), adapter (`node` or `mock`), `dbPath`, `dashboardAvailable` / `dashboardUrl` / `dashboardDisabledReason`, `cues` / `cuesMidSet`, `autoArm`, `voiceReady`, push-channel status, lease holder                                                                                                   |
| `slot.identify {slot, durationMs?}`                   | Briefly switch the slot's device into Damper (visible screen change), then revert. 500..10 000 ms, default 3 000. `ALREADY_IN_DAMPER` if it was already there; `SLOT_NOT_BOUND` if unknown                                                                                                                                        |
| `slot.bind {deviceId, physicalSide}`                  | Persist device to `left` / `right`. Survives restarts. `physicalSide` is the user-facing label, not a slot id                                                                                                                                                                                                                     |
| `slot.bindings_list`                                  | Every persisted binding, sorted by deviceId                                                                                                                                                                                                                                                                                       |
| `slot.unbind {deviceId}`                              | Remove a binding. Returns it, or `null`                                                                                                                                                                                                                                                                                           |
| `slot.swap`                                           | Swap the two connected slots' device bindings in memory, no device traffic. Needs exactly two connected slots                                                                                                                                                                                                                     |

## The connect sequence, every session

```
1.  device.scan
2.  device.connect {deviceId, slot: 'auto'}          # or explicit slot; once per Voltra
        first pairing: the lifter accepts on the device; allow up to 30 s
        CONNECTION_REFUSED → ask them to accept on the device, then connect again (never retried for you)
        stateConfirmed: false → setters refuse with DEVICE_STATE_UNKNOWN until the device reports its settings
3.  system.lease_acquire                              # acquired:true, or LEASE_HELD* → see 07
4.  server.health
        → dashboardAvailable, dashboardUrl, cues, cuesMidSet, autoArm, voiceReady, adapter
5.  If dashboardAvailable: tell the user dashboardUrl exactly as reported
        It ends in /app. The port may not be the default if another session held it.
        dashboardDisabledReason: "disabled" → it was turned off on purpose; say nothing more
6.  profile.get_onboarding_gaps
        → ask the first missing[] item; see 12-onboarding-gaps-and-tier-signal.md
7.  device.get_state per slot                         # mode, weight, battery, state_confirmed, mode_revert_latched
```

Why the explicit lease call when the first write would take it anyway: the lease error you would otherwise hit is on `bilateral.cascade` or `set.start`, with the user already holding the handle. `LEASE_HELD_ENGAGED` means another client is actively driving the device. Recovery is in `07-recovery-and-escalation.md`.

Why `server.health` here: the dashboard binds after the server instructions are sent, so its URL exists nowhere else. It also tells you whether spoken cues are armed (`cues`, `cuesMidSet`), whether auto-arm is on (`autoArm`), and whether voice can transcribe at all (`voiceReady.whisperCli`, `voiceReady.model`; false means speech will not work, so say so before relying on it). If `dashboardAvailable` is false with a null reason on a machine that normally has one, a stale server from another session may hold the port; say so and move on.

`get_state.connectionState: "awaitingAcceptance"` means a connect is still waiting for the lifter to accept on the device.

Push events only register when Claude Code was launched with `--channels plugin:voltras-channel@voltras-local`. The server emitting does not prove the host is delivering. If you see no `<channel>` tags after connect, probe once: `debug.push_test_channel`, read the nonce off the tag, `debug.confirm_channel {nonce}`. No tag arriving means you are on polling for the session; plan for it (poll `set.live_metrics` sparingly, use `timer.wait` for rests).

## Best-practice flows

### Flow A — single device, first time

```
device.scan → {devices: [{deviceId: "VTR-…", …}]}
device.connect {deviceId}                # slot defaults to primary
system.lease_acquire → server.health → profile.get_onboarding_gaps
```

No side ritual for a single device.

### Flow B — single device, known binding

```
device.scan
slot.bindings_list → [{deviceId: "VTR-…", physicalSide: "right"}]
device.connect {deviceId, slot: "auto"}  # lands on slot "right"; there is no primary slot now
```

Everything downstream must use the resolved slot id, not `primary`. `session.start`, `set.start`, `set.end`, `session.end` all default to `primary` when `slot` is omitted, which does not exist on this rig and fails with `SLOT_NOT_BOUND`. Pass `slot` explicitly.

### Flow C — bilateral, first time (full ritual)

```
device.scan → two devices
device.connect {deviceId: A, slot: "left"}
device.connect {deviceId: B, slot: "right"}
"I'll change the display on the cable I think is your left. Watch which one changes."
slot.identify {slot: "left", durationMs: 3000}
ASK: "Left or right?"  → correct: continue; reversed: slot.swap, then re-confirm
slot.bind {deviceId: A, physicalSide: "left"}
slot.bind {deviceId: B, physicalSide: "right"}
```

One to two minutes the first time, zero after. Say "this is a one-time thing."

### Flow D — bilateral, known bindings

```
device.scan → two devices
slot.bindings_list → both present
device.connect {deviceId: A, slot: "auto"}  → left
device.connect {deviceId: B, slot: "auto"}  → right
```

Confirm once: "Left is VTR-A, right is VTR-B." If the user pushes back, `slot.identify` and `slot.swap`.

### Flow E — "the sides are reversed"

```
slot.swap → {left: {deviceId: B}, right: {deviceId: A}}
slot.bind {deviceId: B, physicalSide: "left"}
slot.bind {deviceId: A, physicalSide: "right"}
```

`slot.swap` is in-memory; the two `slot.bind` calls fix persistence. Settings on the physical cables do not move; only the mapping flips. Verify with `get_state` before the next lift.

### Flow F — ambient discovery via passive scan

```
device.set_passive_scan {enabled: true, intervalSeconds: 10}
← voltras_available device_count="1" device_ids="VTR-…"
"Your Voltra just came online. Connect?"
device.connect {deviceId, slot: "auto"}       # scanner pauses itself while a slot is connected
```

### Flow G — another client holds the lease

```
system.lease_acquire → {acquired: false, holder: {clientId, lastActivityAt}, hint}
```

Read `lastActivityAt`. A holder idle for a long time is usually an abandoned session (a stale MCP from another Claude Code window). Ask the user before `force: true`; the steal unloads the other client's device and surrenders its in-flight set. If the steal cannot confirm the cable is unloaded, do not pass `acceptLoadedDevice: true` unless the user confirms nobody is on the machine. Full detail in `07-recovery-and-escalation.md`.

## Channel events to watch

- **`connection_changed`**: every connect and disconnect, with `state`, `disconnected_at`, and `mid_set` when a set was open. A disconnect mid-set is followed by `set_ended` with `closed_by: disconnect`.
- **`voltras_available`**: only when passive scan is on and no slot is connected. `device_count`, `device_ids`.

## Pitfalls

- **A bilateral rig has no `primary` slot.** Every session/set tool defaults `slot` to `primary`. Always pass `slot`.
- **In-memory slot state does not survive a server restart.** Persisted bindings do. After any restart, rescan and reconnect with `slot: 'auto'`.
- **`device.scan` returns every nearby Voltra.** Show the list when more than two appear and let the user pick.
- **A stale scan.** `device.connect` only knows the last scan. Scan again before a reconnect.
- **A replaced device id** (hardware swap) leaves a stale binding. Run the ritual once, `slot.bind` the new id, `slot.unbind` the old one.
- **Passive scan and an active connection are mutually exclusive at the adapter.** The scanner pauses itself; don't manage it.
- **Don't disconnect to fix a stuck load.** `device.disconnect` drops the link but not the load. `device.unload` is the release; disconnect afterwards if needed.
- **Don't disconnect with a set open.** `set.end` and `session.end` first, or the in-flight set is never persisted.

## Cross-refs

- Loading the cable after connect: `02-setter-cascade-and-verification.md`
- Onboarding gaps and the tier signal: `12-onboarding-gaps-and-tier-signal.md`
- Lease contention and reconnects: `07-recovery-and-escalation.md`
- Slot vocabulary: `00-device-model.md`
