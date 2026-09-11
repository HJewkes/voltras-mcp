# Settings / mode / load / lifecycle vocabulary (VW-156)

Four distinct layers get talked about as though they were one thing — "load" in
particular gets used for at least three of them. This doc names the layers, the tools
that belong to each, and the `device.get_state` fields each one owns, so the same word
always means the same layer.

## The motivating confusion (2026-08-01)

At the bench, "start with resting weight" was taken to mean the guided-load ceremony
(`device.start_guided_load`). It actually meant a **setting** (`device.set_weight`) plus
a plain **lifecycle** call (`set.start`) — no engagement ceremony at all. Full writeup
(active-work notes, outside this repo):
`sources/notes/2026-08-01-vmcp-02-22-cable-engagement-from-pre-extended-state-still-reproduces.md`.
That note's finding: with the cable held pre-extended, `set.start` returns `ok` and
records reps, but `device.get_state.load_state` stays `"unloaded"` throughout — because
`set.start` is a lifecycle call, not an engagement ceremony, and the firmware refuses to
apply load onto an already-extended cable as a safety feature. `device.start_guided_load`
is the sanctioned engagement path for exactly that setup.

## 1. SETTINGS

What the device will apply next: weight, chains, eccentric overload, damper, band
ceiling. These are values, not activity — setting one doesn't start or stop anything.

| Tool                        | Location                        |
| --------------------------- | ------------------------------- |
| `device.set_weight`         | `src/tools/device-tools.ts:677` |
| `device.set_chains`         | `src/tools/device-tools.ts:759` |
| `device.set_eccentric`      | `src/tools/device-tools.ts:786` |
| `device.set_damper_level`   | `src/tools/device-tools.ts:817` |
| `device.set_band_max_force` | `src/tools/device-tools.ts:861` |

`device.get_state` fields: `weightLbs`, `chainSettingLbs`, `eccentricPercentTenths`,
`damperLevel` (`src/tools/device-tools.ts:1722-1736`). **Band max force is the
exception** — `device.set_band_max_force` writes `bandMaxForceLbsTenths`
(`src/tools/device-tools.ts:869`) but that field is never copied into the
`device.get_state` snapshot, so it cannot be read back directly; only a
`setting_coerced` event on that field would surface a mismatch.

A setting written under tension is a firmware no-op until the cable goes slack — it
never changes the rep in progress (`src/tools/device-tools.ts:375`, the
`device.set_weight` description, VW-170).

## 2. TRAINING MODE

What discipline the device is configured for.

| Tool                          | Location                        |
| ----------------------------- | ------------------------------- |
| `device.set_mode`             | `src/tools/device-tools.ts:700` |
| `device.configure_isokinetic` | `src/tools/device-tools.ts:974` |
| `device.enter_row_mode`       | `src/tools/device-tools.ts:722` |

`device.get_state` fields: `requested_mode` and `active_mode`
(`src/tools/device-tools.ts:1743-1744`) — what was asked for vs. what the device
reports — plus `mode_revert_latched` (`src/tools/device-tools.ts:1772`), which means the
device bounced back out of the requested mode on its own.

## 3. ENGAGEMENT / LOAD STATE

Whether the cable is mechanically under tension right now. This is independent of both
SETTINGS and MODE — you can have a weight and a mode configured with the cable
completely slack.

| Tool                       | Location                         |
| -------------------------- | -------------------------------- |
| `device.start_guided_load` | `src/tools/device-tools.ts:1084` |
| `device.exit_guided_load`  | `src/tools/device-tools.ts:1268` |
| `device.unload`            | `src/tools/device-tools.ts:1044` |

`device.get_state` fields: `load_state` and `guided_load` (`phase`,
`countdown_remaining_ms`, `fitness_mode_raw`) (`src/tools/device-tools.ts:1747-1752`).

The guided-load ceremony (armed → countdown → engaging → active) is the sanctioned way
to apply load onto an already-extended cable. The plain `set.start` path does not run
that ceremony at all — it stays `load_state: unloaded` even while recording reps
(VMCP-02.22 finding, see [above](#the-motivating-confusion-2026-08-01)).

The ceremony crosses into the MODE layer in one place: it requires Weight Training
(VMCP-02.90). From Damper the firmware never engages — the phase holds at `armed` for
the full 18s poll window and then times out — so `device.start_guided_load` refuses with
`GUIDED_LOAD_MODE_MISMATCH` from any non-Weight-Training mode, and only changes the mode
itself when the caller passes `autoSwitchMode: true`. No other mode has been tested
against the ceremony; the allowlist is one mode wide by choice, not by omission.

### What "ok" means on the three engagement writes (VMCP-02.88)

`ok: true` on `device.start_guided_load`, `device.exit_guided_load` and `device.unload`
reports one thing only: the write completed without an error. It is not a claim that the
device did what was asked. Each of the three now carries a `read_back` object saying what
was observed afterwards — read `read_back.verdict` for the answer — and an observed
contradiction is a structured error rather than a success.

| Field                 | Meaning                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `verdict`             | `confirmed` only when a device-sourced read matched the request; otherwise `unconfirmed`  |
| `source`              | `device` when the value came off the unit, `server` when it is this process's bookkeeping |
| `observed_phase`      | The guided-load phase read after the write                                                |
| `observed_load_state` | `device.unload` only — the `load_state` summary read after the write                      |
| `unconfirmed_reason`  | Present exactly when `verdict` is `unconfirmed`; says what could not be established       |
| `waited_ms`           | `device.start_guided_load` only — how long the read-back waited                           |
| `ceremony_skipped`    | `true` when the device reported engagement with no countdown observed first               |

How much each can observe differs, and the difference belongs to the SDK, not to a choice
made here (`src/tools/guided-load-readback.ts`):

- **`device.start_guided_load`** can be confirmed. Its status poll is running, and
  `countdown`, `engaging` and `active` are reachable only by decoding a device status
  response. `armed` is not: the SDK synthesises `armed` locally on the trigger write and
  also derives it from a status response, so the value cannot tell the two apart and is
  never treated as confirmation. A phase outside the active set after the trigger is a
  `GUIDED_LOAD_NOT_ARMED` error.
- **`device.exit_guided_load`** cannot be confirmed at all. The SDK stops the status poll
  before writing the exit, so nothing reads the device afterwards. A phase still inside
  the active set is a `GUIDED_LOAD_EXIT_UNCONFIRMED` error.
- **`device.unload`** cannot be confirmed at all. The write has no echo, and `load_state`
  reads `unloaded` during ordinary weight reps too, so it cannot tell a released cable
  from a slack one. When the call tore down a live flow and the phase is still inside the
  active set, that is an `UNLOAD_UNCONFIRMED` error.

Four things the mock adapter cannot reach, so no test result speaks to any of them:

1. The **no-op unload** — the mock has no cable and no residual tension.
2. **Exit while still displayed** — the mock's exit is instantaneous and total.
3. The **wedged mode** from a physically-selected Damper (VMCP-02.61) — no physical
   selector exists to wedge.
4. The **idle-at-base-weight short-circuit** (VMCP-02.20), and engagement generally — the
   mock answers no guided-load status read, so the phase never leaves `armed` on its own.

So the contradiction paths and the bounds are tested; the device-sourced confirmation path
is not. VMCP-02.88 and VMCP-02.89 stay open until a bench sitting covers it.

Two phase names promise more than they deliver, and the names are the SDK's (VMCP-02.89).
`timeout` is the SDK's own poll window closing with no engagement reported — a silence,
not a device-reported failure. Whether `active` coincides with the cable mechanically
engaging or merely with the device entering the mode is unverified; the mock cannot answer
it and no hardware measurement exists.

## 4. RECORDING LIFECYCLE

Whether reps and sets are being persisted, independent of settings, mode, or engagement.

| Tool                   | Location                         |
| ---------------------- | -------------------------------- |
| `session.start`        | `src/tools/session-tools.ts:136` |
| `session.end`          | `src/tools/session-tools.ts:143` |
| `session.set_exercise` | `src/tools/session-tools.ts:150` |
| `session.list`         | `src/tools/session-tools.ts:164` |
| `session.get`          | `src/tools/session-tools.ts:171` |
| `set.start`            | `src/tools/set-tools.ts:193`     |
| `set.end`              | `src/tools/set-tools.ts:202`     |

`device.get_state` fields: `is_recording` and `active_set`
(`src/tools/device-tools.ts:1746,1753`).

Two lifecycle behaviors worth naming:

- **Auto-arm** (VW-164/VW-181): `autoArmSet` (`src/state/auto-arm.ts:72`) opens a set on
  the lifter's own reps during an open session, before any `set.start` call, when
  `VMCP_AUTO_ARM=on` (the default).
- **Upgrade in place**: calling `set.start` against an auto-armed set does not fail —
  it applies `setPurpose`/`watch` to the set already running and returns
  `upgraded: true` (`src/tools/set-tools.ts:127-156`).

## Quick disambiguation for "load"

| If you mean...                                            | Say                              | Not          |
| --------------------------------------------------------- | -------------------------------- | ------------ |
| The weight/chains/damper/band value the device will apply | a **setting**                    | "load"       |
| Whether the cable is mechanically under tension           | **engagement** or **load state** | "load" alone |
| Whether reps are being recorded                           | the **lifecycle**                | "loaded"     |
