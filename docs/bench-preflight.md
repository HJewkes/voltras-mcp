# Bench pre-flight

Every gate below fails **silently**: the server starts, the tools answer, and the
capability you were counting on just never produces an event. That shape cost most of a
hardware sitting on 2026-08-11 and reappeared on 2026-09-07. `scripts/voltra-pt` now runs
the checks before it launches Claude Code, so they surface while you are still at the
keyboard rather than mid-set.

This is the automated form of Phase 0 in
`sources/runbooks/BENCH-2026-07-26-consolidated.md`.

## What runs

`scripts/voltra-pt` calls two scripts, in order, unless `VOLTRA_PT_SKIP_PREFLIGHT=1`:

1. `scripts/ensure-whisper.mjs` — rebuilds the whisper CLI if it is missing.
2. `scripts/preflight.mjs` — prints one line per gate and exits non-zero on a blocker.

Both are runnable on their own. `npm run preflight` is the second one.

## `ensure-whisper` (VW-155)

`nodejs-whisper` ships C++ sources, not a binary. It compiles them the first time it
transcribes, into `node_modules/nodejs-whisper/cpp/whisper.cpp/build/`. `npm ci` deletes
`node_modules` wholesale, so the package comes back and the compiled
`build/bin/whisper-cli` does not. Nothing reports this: `system.listen_start` succeeds,
the mic records, and no utterance is ever transcribed.

`scripts/ensure-whisper.mjs` runs from `postinstall` and again from `voltra-pt`. It prints
exactly one line and **never exits non-zero**, so a machine without a C++ toolchain still
gets a clean `npm ci`:

| Situation                     | Line          | Effect                            |
| ----------------------------- | ------------- | --------------------------------- |
| Binary present                | `OK: ...`     | nothing                           |
| Binary missing, cmake present | `BUILD: ...`  | runs cmake, a few minutes         |
| Binary missing, no cmake      | `SKIP: ...`   | install succeeds, voice stays off |
| `VMCP_SKIP_WHISPER_BUILD=1`   | `SKIP: ...`   | never builds                      |
| `CI` set                      | `SKIP: ...`   | keeps CI fast; voice is untested there |
| cmake ran but produced nothing| `FAILED: ...` | install still succeeds            |

To rebuild by hand: `node scripts/ensure-whisper.mjs`.

## `preflight` gates

One line each, in this order. Only the first two exit non-zero.

| Gate             | Level  | Why it is silent otherwise                                                                                                                                    |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whisper`        | FAIL   | Missing `whisper-cli` (above). The model alone is only a WARN — it downloads on demand.                                                                        |
| `node`           | FAIL   | Below v22.5 there is no `node:sqlite`, and the startup error names a module, not a version.                                                                    |
| `push-channel`   | WARN   | `VOLTRA_PT_DEV=1` selects `--dangerously-load-development-channels`, which needs an approval dialog nobody answers in a scripted session, so it registers nothing and push degrades to polling (VW-158). |
| `cues`           | WARN   | An unset `VMCP_CUES` means nothing speaks. The line always prints both effective values, because `target_hit` / `slowdown` additionally need `VMCP_CUES_MIDSET=on`. |
| `dashboard-port` | WARN   | Every session spawns its own server and the first one wins port 7723, so a dashboard opened from a second session shows another session's data or nothing.       |

Inside a running session, `server.health` reports the same voice state as
`voiceReady: { whisperCli, model }`, plus the live `cues` / `cuesMidSet` values.
