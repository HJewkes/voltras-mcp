# Dashboard driver fidelity ladder (VMCP-01.74)

There are five ways to get the dashboard rendering a workout. They sit at different
points on a fidelity ladder — from a scripted fake state object up to a real Voltra —
and each trades off setup cost against what it can actually prove. Every claim below
cites a script, a `package.json` script name, or a `file:line` on `main`.

| Driver                                                | How to run it                                                                                           | Code path                                                                                                                                                                                                                                                                                                                                                                                   | Live reps                                                                                              | Prescription / plan                                                                                                                                                                              | Bilateral                                                                                                                                             | Cues                             | Timers                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real device                                           | `npm start` (`VOLTRA_ADAPTER=node`, the default) — [README "Option A"](../README.md#your-first-workout) | `src/bin.ts:2` → `src/server.ts` → `src/tools/device-tools.ts`, `src/tools/session-tools.ts`, `src/tools/set-tools.ts`, `src/tools/plan-tools.ts`                                                                                                                                                                                                                                           | Yes — real BLE telemetry through the event-bridge                                                      | Yes — real `plan.*` tools, attached with `plan.attach_to_session` (`src/tools/plan-tools.ts:292`)                                                                                                | Yes — `device.connect` a second Voltra into `left`/`right` (`src/schemas/common.ts:37`)                                                               | No dashboard surface (see below) | Yes, full — real `timer.*` tools plus the `VMCP_REST_TIMER` auto `rest_status` cascade                                                                                                                                                                                                            |
| `scripts/dashboard-sim.mjs` (`npm run dashboard:sim`) | `npm run dashboard:sim`                                                                                 | `scripts/dashboard-sim.mjs:1` — no MCP server, no SDK; imports `startDashboardServer` (`src/dashboard/server.ts:236`) and `LiveSignalHub` (`src/state/live-signal.ts:188`) directly and mutates a fake `DashboardServerState` on a timer                                                                                                                                                    | Yes, synthetic — reps are fabricated and pushed in (`scripts/dashboard-sim.mjs:300-317`)               | **No.** The fake store carries no plan data at all (`scripts/dashboard-sim.mjs:95`: "Minimal store: no history, no plan preview")                                                                | Yes — `DUAL=1` drives `left`/`right` (`scripts/dashboard-sim.mjs:58`), `TRANSITIONS=1` binds/drops a slot mid-set (`scripts/dashboard-sim.mjs:22-26`) | No dashboard surface (see below) | Partial — the script nulls the active set before sleeping (`scripts/dashboard-sim.mjs:328-331`), which the SPA's own adapter turns into the rest count-up clock (`src/dashboard/spa/adapter.ts:675-677`); there is no MCP server, so no real `timer.*` call and no `VMCP_REST_TIMER` cascade fire |
| `scripts/dashboard-mock-drive.mjs`                    | `node scripts/dashboard-mock-drive.mjs`                                                                 | `scripts/dashboard-mock-drive.mjs:1` — boots the real MCP server (`dist/bin.js`) with `VOLTRA_ADAPTER=mock` and drives it over stdio JSON-RPC through the real tools (`device.scan` → `device.connect` → `session.start` → `set.start`/`set.end` × N → `session.end`)                                                                                                                       | Same real pipeline as hardware, minus BLE: `MockBLEAdapter` → event-bridge → `LiveState.processSample` | **No.** Starts a bare single-exercise session with no plan attached — this is the gap `dashboard-plan-drive.mjs` exists to fill (its own header says so, `scripts/dashboard-plan-drive.mjs:5-6`) | Yes — `--dual` drives two slots through the real pipeline (`scripts/dashboard-mock-drive.mjs:28-45,94`)                                               | No dashboard surface (see below) | Yes, full — sets `VMCP_REST_TIMER: 'on'` (`scripts/dashboard-mock-drive.mjs:169`), so the real auto `rest_status` cascade fires on natural set close                                                                                                                                              |
| `scripts/dashboard-plan-drive.mjs`                    | `node scripts/dashboard-plan-drive.mjs`                                                                 | `scripts/dashboard-plan-drive.mjs:1` — sibling of `dashboard-mock-drive.mjs`; same real MCP-server-in-mock-mode pipeline, but also seeds a real plan (program → block → week → template → planned exercises) through the real `plan.*` tools and attaches it via `plan.attach_to_session` (`src/tools/plan-tools.ts:292`), so `fetchSessionPlan` resolves it by genuinely walking the store | Yes, real pipeline (same as `dashboard-mock-drive.mjs`)                                                | **Yes.** The only headless driver that can                                                                                                                                                       | No — pinned to a single device (`scripts/dashboard-plan-drive.mjs:141-142`)                                                                           | No dashboard surface (see below) | Yes, full — sets `VMCP_REST_TIMER: 'on'` (`scripts/dashboard-plan-drive.mjs:139`)                                                                                                                                                                                                                 |
| `scripts/dashboard-replay-drive.mjs` (VW-256)         | `node scripts/dashboard-replay-drive.mjs --capture=<path>`                                              | `scripts/dashboard-replay-drive.mjs:1` — boots the real MCP server the same way, but `--import scripts/replay-preload.mjs` swaps the mock manager's adapter for the SDK's `ReplayBLEAdapter`, fed by `loadCaptureFrames` (`@voltras/node-sdk/testing`) reading a capture recorded off a REAL Voltra (`VMCP_RECORD_SESSION=1`, `src/state/session-recorder.ts`)                              | **Yes — the only driver replaying REAL recorded telemetry, off-hardware.** No live BLE                 | No — a bare ad hoc set, same gap `dashboard-mock-drive.mjs` has                                                                                                                                  | No — single slot only                                                                                                                                 | No dashboard surface (see below) | Yes, full — sets `VMCP_REST_TIMER: 'on'`                                                                                                                                                                                                                                                          |

**The finding to take away:** `dashboard-sim` cannot express a prescription — its store
carries no plan data at all. If you need to check a plan-related visual (the header's
`sets x reps @ load` lockup, the rail's `upcoming` rows, the strip's `todo` columns),
use `dashboard-plan-drive.mjs` or a real device with a plan attached — `dashboard-sim`
and plain `dashboard-mock-drive` cannot show it.

**Both real-pipeline drivers can be pinned.** `dashboard-plan-drive.mjs --pinned-reps=N`
and `dashboard-mock-drive.mjs --dual --pinned` run each set as an exact rep burst from a
mock device parked before and after it, so every value on the dashboard repeats run to
run ([`scripts/lib/mock-burst.mjs`](../scripts/lib/mock-burst.mjs)). Off by default —
free-running telemetry is what you want when watching a demo, and pinned is what
`npm run docs:captures` needs ([screenshot-harness.md](screenshot-harness.md)).

**`dashboard-mock-drive` records the load its sets were performed at, and can drive a
PR (VW-384).** A stored set takes `weightLbs` / `trainingMode` from the slot's device
snapshot, and that snapshot is only ever filled from the device's own settings echo
(`src/tools/set-tools.ts`, `src/state/event-bridge.ts`). The SDK's mock adapter answers a
weight write with nothing at all, so a stock mock run used to record sets performed
against no load — which is why `goal.propose_targets` came back NOT_FOUND for a
mock-driven lift. The driver now writes `--load=<lbs>` (default 100) with
`device.set_weight` before the first set and boots the server with
`--import scripts/mock-settings-echo-preload.mjs`, which replays that write back as the
settings echo hardware sends.

`--goal=<exerciseId>` runs the goal-coach loop on top of it: seed one working set in the
previous ISO week, `goal.declare_priorities` the lift, `goal.propose_targets`,
`goal.accept_target`, drive one set at the seeded load and one at `--goal-pr-load`
(default +10 lb), `session.end`. Open `#/goals` afterwards and the accepted target's card
carries the PR star. The prior week is seeded rather than driven because `history.trend`
buckets its series by ISO week and keeps each bucket's heaviest load: both sets of one run
land on a single point, and a single point has nothing earlier to beat
(`src/analytics/goal-history.ts`).

`--goal-companions=<id:lbs,...>` declares more lifts at `maintain` beside the lead, each with
its own seeded prior week at that load and an accepted target, so `#/goals` shows its Per-lift
section: the lead has the large card and is never listed there. The capture scenario passes a
cable row and a cable overhead tricep extension, the long name listed first so the phone shot
shows it wrapping.

**Cues have no dashboard surface at all, on any driver.** Coaching cues are spoken
audio (`system.speak`), not a rendered value — there is no `VMCP_CUES` / cue read-out
anywhere under `src/dashboard`. The dashboard's own "cue" language (the nav item's
live-session dot, the live-page `AlertCue` verdict badge) is unrelated UI terminology,
not the coaching-cue vocabulary from [`docs/vocabulary.md`](vocabulary.md).

**The replay driver treats a whole capture as one set.** `loadCaptureFrames` keeps only
`frame_in` lines it classifies as `telemetry_stream` — any device-sent set-boundary frame
the original bench session produced is filtered out before replay ever sees it, so there
is no capture-native signal to slice a multi-set session into separate dashboard sets.
`dashboard-replay-drive.mjs` opens one `set.start` before triggering playback and one
`set.end` after the capture drains; reps accrue into that one set exactly as recorded.
Playback itself is driven through `scripts/replay-preload.mjs`'s loopback control server
(`POST /play`, `GET /status`) rather than starting on `device.connect`, because
`LiveState.processSample` only accumulates samples into a set that is already open —
starting on connect risks streaming (and dropping) a short capture before `set.start`
ever runs. There is no real capture on this machine yet; a capture is produced by running
the MCP server with `VMCP_RECORD_SESSION=1` against a real Voltra
(`src/state/session-recorder.ts`) — captures hold raw device frames and stay private
(never committed; see the confidentiality section of the repo's `CLAUDE.md`).

## The ladder is about the LIVE page. `dashboard:preview` is about the others (VW-416)

Every driver above exists to put reps on the live page. The wall's other three pages —
`#/goals`, `#/body`, `#/plan` — read the STORE, not the live state, so a driver that
streams telemetry into a fresh store renders them empty or nearly so. `npm run
dashboard:preview -- <goals|body|plan>` is the other shape: seed the store, boot the same
`dist/bin.js` in mock mode over it on a probed-free port, print the URL, hold it open until
Ctrl-C, and delete the scratch store on the way out.

```bash
npm run dashboard:preview -- goals --state behind
```

It is not a sixth rung on this ladder — it drives nothing. `body` and `plan` reuse the
capture harness's own scenarios (`src/docs/capture-shots.ts`), which means `plan` runs
`dashboard-plan-drive.mjs` from the row above and `body` runs the store seed
`dashboard-body-seed.mjs`. Only `goals` has a seed of its own
([`src/docs/preview-seeds.ts`](../src/docs/preview-seeds.ts)), because
`dashboard-mock-drive.mjs --goal=` can only ever produce the `calibrating` state: a band
derived with no baseline past `SHAPE_ONLY` is the programmed execution ramp by
construction, whatever the driven sets do. The six `--state` names seed the readings for
the other verdicts, and `src/dashboard/__tests__/preview-seeds.test.ts` pins which status
each one reaches.

`dashboard-sim` cannot stand in for any of this, for the same reason it cannot show a
prescription: its fake store answers `listSessions` with an empty array and carries no plan
or goal data at all.
