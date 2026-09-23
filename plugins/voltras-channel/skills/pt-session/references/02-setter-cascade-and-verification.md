# Setter cascade and verification

**When to read this.** You're about to load the cable for a set; OR a setter returned ok but the screen disagrees; OR you need to configure Isokinetic; OR the user wants guided load and you need to know what it actually does; OR a stop or unload came back `unconfirmed`.

The cardinal rule: **every setter write must be verified.** A write can succeed at the transport layer and be clamped, dropped, or reverted by the device. Without verification you can announce "30 pounds loaded" when the cable has 200.

## Tool inventory

| Tool                                                                                                                                                       | What it does                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bilateral.cascade {slots?, mode, weightLbs, eccentricOverloadLbs, chainsLbs, abortOnFirstFailure?}`                                                       | All four setters across one or more slots in one call. **Full-settings contract: all four fields are required**; a partial cascade is rejected with `INVALID_INPUT` naming the missing setters. Defaults `slots` to every connected slot. Returns one `results[i]` per slot with `applied.<setter>` and `modeEcho`. **Do not use it to enter a non-WeightTraining mode** (below) |
| `device.set_mode {slot, mode}`                                                                                                                             | Single setter, single slot. The way into Isokinetic and every other non-WeightTraining mode. `Idle` is rejected                                                                                                                                                                                                                                                                  |
| `device.set_weight {slot, lbs}`                                                                                                                            | 5..200 lb. Returns `weightChangeWarning` when written under tension                                                                                                                                                                                                                                                                                                              |
| `device.set_eccentric {slot, overloadLbs}`                                                                                                                 | -195..+195 lb on the eccentric. `percent` is a deprecated alias, same meaning. Returns `mountLoadWarning` when no mount rating is configured                                                                                                                                                                                                                                     |
| `device.set_chains {slot, lbs}`                                                                                                                            | 0..100 lb; device caps at weight                                                                                                                                                                                                                                                                                                                                                 |
| `device.set_assist_mode {slot, mode}` / `set_damper_level` / `set_band_max_force`                                                                          | Mode-config setters; no confirmation echo                                                                                                                                                                                                                                                                                                                                        |
| `device.configure_isokinetic {slot, targetSpeedMmPerSec, eccMode, eccConstWeightLbs?, eccOverloadWeightLbs?, eccSpeedLimitMmPerSec?}`                      | The whole isokinetic config in one call. The five `set_isokinetic_*` setters are deprecated                                                                                                                                                                                                                                                                                      |
| `device.get_state {slot}`                                                                                                                                  | The verification read. Flat fields: `weightLbs`, `chainSettingLbs`, `requested_mode`, `active_mode`, `load_state`, `state_confirmed`, `connectionState`, `mode_revert_latched` when an abort is pending, and `disconnect_notice` once after a drop. Values are the last known ones across a disconnect, not defaults                                                             |
| `device.unload {slot}`                                                                                                                                     | Release the cable. Idempotent. If a guided load is active it also exits it and reaps the auto-created set. **Read `read_back.verdict`**                                                                                                                                                                                                                                          |
| `device.start_guided_load {slot, targetWeightLbs, exerciseName?, exerciseId?, isWarmup?, watch?, autoSwitchMode?, inactivityTimeoutSeconds?, skipUnload?}` | The contracted-position start ceremony. Experimental. Auto-unloads first; from Idle it sets WeightTraining first. Auto-creates a session and set unless a session is already active on the slot                                                                                                                                                                                  |
| `device.exit_guided_load {slot}`                                                                                                                           | Leave a guided load. Experimental. Its read-back is always `unconfirmed`                                                                                                                                                                                                                                                                                                         |

Right after a connect, every setter refuses with `DEVICE_STATE_UNKNOWN` until `get_state.state_confirmed` is true. Wait and re-read. Stops and unloads are never held back.

## Use `bilateral.cascade` for WeightTraining, and only there

For the normal strength cascade (mode + weight + eccentric + chains) one call does everything, fans out across slots, and is idempotent because all four values are always specified:

```
bilateral.cascade {
  mode: "WeightTraining",
  weightLbs: 30,
  eccentricOverloadLbs: 8,    # +8 lb on the eccentric — see 00-device-model.md
  chainsLbs: 0
}
```

Same call for single-device (one result) and bilateral (two results).

How it orders the writes: the mode goes first and alone. When the requested mode differs from the one the device reports, the cascade waits for the device to echo it before weight, eccentric and chains go out. Each `results[i].modeEcho` is `confirmed` (with `echoedAfterMs`), `skipped` (mode unchanged) or `timeout`. **On `timeout` that slot FAILED and its other setters were never issued.** Re-issue `device.set_mode` for that slot and read `get_state` before retrying.

**Non-WeightTraining modes are the exception (VW-162, open).** On 2026-09-07 a cascade carrying `mode: "Isokinetic"` reverted both units within a second while every `applied.*` said ok. The cascade has waited for the mode echo since then, but the task is still open and `device.set_mode`'s own description still says to set the mode per slot first. So:

```
device.set_mode {slot: "left",  mode: "Isokinetic"}
device.set_mode {slot: "right", mode: "Isokinetic"}
device.get_state per slot → requested_mode and active_mode both "Isokinetic"
device.configure_isokinetic {slot: "left",  targetSpeedMmPerSec: 300, eccMode: "constant", eccConstWeightLbs: 20}
device.configure_isokinetic {slot: "right", …}
device.get_state per slot again; ask the user to read the isokinetic screen values
```

Isokinetic settings persist per unit and `configure_isokinetic` cannot read them back, so two units that have lived different lives will disagree until you write every field you care about on both. The eccentric-weight fields make the device beep; that is normal.

## Per-write verification

After ANY cascade or setter, before "ready when you are":

```
device.get_state {slot: "left"}
   → {weightLbs: 30, requested_mode: "WeightTraining", active_mode: "WeightTraining",
      chainSettingLbs: 0, load_state: "unloaded", state_confirmed: true, …}
```

Compare against intent:

- **Match**: announce the loaded state and proceed.
- **Mismatch**: re-issue ONLY the diff with the single setter (`device.set_weight`, not a cascade). Verify again.
- **Two mismatches on the same slot**: stop the user, have them read the screen, escalate per `07-recovery-and-escalation.md`. Do not let them lift.

Read `weightLbs`, `active_mode`, `chainSettingLbs`, `damperLevel`. `get_state` has no eccentric-overload field in pounds. Trust the cascade's `applied.eccentric` plus the absence of a `setting_coerced` event for the eccentric, and confirm the eccentric on the device screen the first time in a session.

## When a setter is coerced

The device clamps some values (chains above weight, weight above the cable's max). The server publishes `setting_coerced` when the echo disagrees with the request. Eccentric needs 2 matching observations before firing (it has a known transient burst during cascade settle); weight, chains, damper and assist fire on the first non-matching echo.

1. **Do not retry.** A clamp is deliberate.
2. **Tell the user** what was clamped and to what.
3. **Update your intent** so later verification expects the coerced value.

Mode-config setters (isokinetic, damper, band, assist) produce no confirmation echo, so their coercion checks expire silently. For those, the screen is the verification. `setting_coerced` is live-only; `report.weekly` cannot list it afterwards.

## Weight changes

- **Between sets**: `device.set_weight`, verify, then `set.start`. The set header takes its weight when the set starts (VW-165), so a weight change after arming leaves the header wrong and fires `weight_implied_mismatch` at close.
- **Under tension**: does not apply to the set in progress. The write still goes through and the result carries `weightChangeWarning`; read it out. If the user asks for more weight mid-set, say "that won't take until you let the cable go slack" and change it at the boundary.
- **By voice**: with `system.listen_start` armed, "set it to 70" / "up 10" / "drop 5" apply locally and arrive as `voice_command_applied`. The write already happened; verify with `get_state` if it matters, do not re-issue.

## Stops and unloads: read the verdict

`device.unload` returns `read_back`:

| `verdict`                       | Meaning                                                   | Do                                                                     |
| ------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------- |
| `confirmed`, `source: "device"` | The device reported the motor release                     | Proceed                                                                |
| `unconfirmed`                   | The device did not report it. **The cable is unverified** | Call `device.unload` again, and confirm by eye before loading a lifter |

`observed_load_state: unloaded` proves nothing: it reads that way during ordinary reps too. When an unload tore down a live guided load and the phase is still active afterwards, the call returns the error `UNLOAD_UNCONFIRMED` instead of a success.

## Guided load: what it is and when to use it

Guided load is not "load the cable." It is a ceremony for **starting a movement from a contracted position** (flys, squats, bench, anything whose first action is a concentric from an already-extended cable). The lifter's experience, recorded from the device owner 2026-08-11:

1. The lifter extends the cable to the movement's length.
2. Holds it stable for about 3 s.
3. The device engages a fraction of the target.
4. The lifter performs the eccentric.
5. Once the cable is fully retracted, the device ramps to target across the first concentric.
6. Subsequent reps are fully loaded.

**It cannot complete without the lifter.** A trigger with nobody on the cable sits in `armed` and then reports `timeout` after the 18 s poll window. That timeout means "nobody extended the cable," not "the device wedged."

Phase vocabulary, as `guided_load_state` and `get_state.guided_load.phase` report it:

| Phase       | Meaning                                   | Caveat                                                                                                                                |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `armed`     | Trigger sent                              | Covers both "waiting for the lifter" and "never entered the mode". It **confirms nothing**: the read-back reports it as `unconfirmed` |
| `countdown` | The ~3 s stability hold is being observed | `countdown_remaining_ms` present                                                                                                      |
| `engaging`  | Fractional resistance coming on           |                                                                                                                                       |
| `active`    | The unit entered the mode                 | **Not** "load is engaged." `ceremony_skipped: true` marks engagement with no countdown seen first                                     |
| `timeout`   | Our poll window expired                   | Says nothing about the device                                                                                                         |
| `exited`    | Our exit was written                      | The unit may still show guided load                                                                                                   |

Rules:

- **From WeightTraining only.** From any other mode the tool refuses with `GUIDED_LOAD_MODE_MISMATCH`, naming the current mode, before anything is written. From Idle the tool sets WeightTraining itself. `autoSwitchMode: true` switches to WeightTraining as part of engaging and waits for the mode echo (`MODE_ECHO_TIMEOUT` if it never lands). It defaults to false on purpose: a lifter who picked Damper on the unit chose it. Ask before you pass it.
- **Read `read_back`.** `ok: true` only says the write completed. `verdict`, `source`, `observed_phase`, `waited_ms` say what was seen. Only `countdown`, `engaging` and `active` come from the device. A phase outside the active set after the trigger is the error `GUIDED_LOAD_NOT_ARMED`. Engagement itself waits on a person pulling the cable and is confirmed by the `guided_load_state` event.
- **Pass `exerciseId` and `exerciseName`** so the auto-created session is attributed. Or `session.start` first; then the auto-set lands in your session.
- **Pass `isWarmup: true` and `watch` on the call for a guided-load warm-up.** The set is created on `armed`, before any `set.start` could run. Without them it records as a working set with no watch, and a warm-up ramp done this way pollutes progression. (The installed skill said this was impossible; VW-168 fixed it.)
- **Its inactivity default is 30 s**, not 90. A guided-load set that fails to engage is reaped quickly. `watch.inactivityTimeoutMs` replaces it for that set.
- **`device.exit_guided_load`'s read-back is always `unconfirmed`**, because nothing observes the exit. It also releases the motor, but nothing confirms that. `device.unload` is the release the device confirms. A phase still active after the exit is the error `GUIDED_LOAD_EXIT_UNCONFIRMED`. It is safe to call after a timeout; `NOT_IN_GUIDED_LOAD` means there was nothing to exit.

## Recipes

### Recipe — first WeightTraining set, bilateral

```
bilateral.cascade {mode: "WeightTraining", weightLbs: 30, eccentricOverloadLbs: 8, chainsLbs: 0}
   → check results[i].modeEcho; read mountLoadWarning out if present
device.get_state {slot: "left"}; device.get_state {slot: "right"}
"Both sides at 30, plus 8 on the eccentric. Ready when you are."
session.start {exerciseId, slot: "left"}; session.start {exerciseId, slot: "right"}   # if not already
set.start {slot: "left", setPurpose: "warmup"}; set.start {slot: "right", setPurpose: "warmup"}   # then the lift
```

### Recipe — drop one side five pounds between sets

```
device.set_weight {slot: "left", lbs: 25}       # single setter, not a partial cascade
device.get_state {slot: "left"}
"Left is 25 now. Right stays at 30."
```

### Recipe — isokinetic strength probe (one unit)

```
device.set_mode {slot: "right", mode: "Isokinetic"}
device.get_state {slot: "right"} → active_mode: "Isokinetic"
device.configure_isokinetic {slot: "right", targetSpeedMmPerSec: 300, eccMode: "constant", eccConstWeightLbs: 20}
device.get_state; user reads the screen
session.set_exercise {exerciseId, slot: "right"}     # if the exercise changed
set.start {slot: "right", setPurpose: "probe"}       # a probe is not a working set
… peak force per rep arrives in rep_finalized …
device.set_mode {slot: "right", mode: "WeightTraining"} when done; verify
```

### Recipe — guided-load start from the bottom position

```
session.start {exerciseId, slot}                     # so the auto-set is attributed and in your session
device.start_guided_load {slot, targetWeightLbs: 55, watch: {…}}     # add isWarmup: true for a ramp set
   → read read_back.verdict and observed_phase
"Pull the bar out to your start position and hold it still. It'll come on light, lower it, and the weight arrives on the first press."
← guided_load_state phase=armed → countdown → engaging → active
← set_started (auto-created set)
… normal set from here …
```

If `guided_load_state` reports `timeout`: ask whether the lifter extended and held the cable. If the call was refused with `GUIDED_LOAD_MODE_MISMATCH`, tell the user which mode the unit is in and ask before switching.

## Pitfalls

- **Don't skip verification.** One call; the safety upside is the whole point of this file.
- **Mismatch budget is 2 per slot.** Then the ladder.
- **Never a partial cascade.** `{slots: ["left"], weightLbs: 25}` is rejected. Single-field changes use the single setter.
- **Never a non-WeightTraining mode inside a cascade** (VW-162, open).
- **A `modeEcho: timeout` slot did not get its weight.** Do not announce it as loaded.
- **Eccentric is pounds.** `eccentricOverloadLbs: 25` at 30 lb is nearly double on the way down, and it raises the pull on the mount.
- **`slot.swap` moves bookkeeping, not settings.** Verify after a swap.
- **A weight change under tension does not apply.** Change it at the set boundary.
- **`unconfirmed` is not "probably fine".** Unload again and look at the cable.

## Cross-refs

- The four layers of "load" and mode names: `00-device-model.md`
- Recording the set you just loaded: `04-set-execution.md`
- `setting_coerced`, `weight_implied_mismatch`, `guided_load_state` payloads: `08-channel-events-reference.md`
- Verify failures and the mode-revert latch: `07-recovery-and-escalation.md`
