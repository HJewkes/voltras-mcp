# Dashboard driver fidelity ladder (VMCP-01.74)

There are four ways to get the dashboard rendering a workout. They sit at different
points on a fidelity ladder — from a scripted fake state object up to a real Voltra —
and each trades off setup cost against what it can actually prove. Every claim below
cites a script, a `package.json` script name, or a `file:line` on `main`.

| Driver | How to run it | Code path | Live reps | Prescription / plan | Bilateral | Cues | Timers |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Real device | `npm start` (`VOLTRA_ADAPTER=node`, the default) — [README "Option A"](../README.md#your-first-workout) | `src/bin.ts:2` → `src/server.ts` → `src/tools/device-tools.ts`, `src/tools/session-tools.ts`, `src/tools/set-tools.ts`, `src/tools/plan-tools.ts` | Yes — real BLE telemetry through the event-bridge | Yes — real `plan.*` tools, attached with `plan.attach_to_session` (`src/tools/plan-tools.ts:267`) | Yes — `device.connect` a second Voltra into `left`/`right` (`src/schemas/common.ts:37`) | No dashboard surface (see below) | Yes, full — real `timer.*` tools plus the `VMCP_REST_TIMER` auto `rest_status` cascade |
| `scripts/dashboard-sim.mjs` (`npm run dashboard:sim`) | `npm run dashboard:sim` | `scripts/dashboard-sim.mjs:1` — no MCP server, no SDK; imports `startDashboardServer` (`src/dashboard/server.ts:231`) and `LiveSignalHub` (`src/state/live-signal.ts:188`) directly and mutates a fake `DashboardServerState` on a timer | Yes, synthetic — reps are fabricated and pushed in (`scripts/dashboard-sim.mjs:300-317`) | **No.** The fake store carries no plan data at all (`scripts/dashboard-sim.mjs:95`: "Minimal store: no history, no plan preview") | Yes — `DUAL=1` drives `left`/`right` (`scripts/dashboard-sim.mjs:58`), `TRANSITIONS=1` binds/drops a slot mid-set (`scripts/dashboard-sim.mjs:22-26`) | No dashboard surface (see below) | Partial — the script nulls the active set before sleeping (`scripts/dashboard-sim.mjs:328-331`), which the SPA's own adapter turns into the rest count-up clock (`src/dashboard/spa/adapter.ts:669-671`); there is no MCP server, so no real `timer.*` call and no `VMCP_REST_TIMER` cascade fire |
| `scripts/dashboard-mock-drive.mjs` | `node scripts/dashboard-mock-drive.mjs` | `scripts/dashboard-mock-drive.mjs:1` — boots the real MCP server (`dist/bin.js`) with `VOLTRA_ADAPTER=mock` and drives it over stdio JSON-RPC through the real tools (`device.scan` → `device.connect` → `session.start` → `set.start`/`set.end` × N → `session.end`) | Same real pipeline as hardware, minus BLE: `MockBLEAdapter` → event-bridge → `LiveState.processSample` | **No.** Starts a bare single-exercise session with no plan attached — this is the gap `dashboard-plan-drive.mjs` exists to fill (its own header says so, `scripts/dashboard-plan-drive.mjs:5-6`) | Yes — `--dual` drives two slots through the real pipeline (`scripts/dashboard-mock-drive.mjs:28-45,81`) | No dashboard surface (see below) | Yes, full — sets `VMCP_REST_TIMER: 'on'` (`scripts/dashboard-mock-drive.mjs:147`), so the real auto `rest_status` cascade fires on natural set close |
| `scripts/dashboard-plan-drive.mjs` | `node scripts/dashboard-plan-drive.mjs` | `scripts/dashboard-plan-drive.mjs:1` — sibling of `dashboard-mock-drive.mjs`; same real MCP-server-in-mock-mode pipeline, but also seeds a real plan (program → block → week → template → planned exercises) through the real `plan.*` tools and attaches it via `plan.attach_to_session` (`src/tools/plan-tools.ts:267`), so `fetchSessionPlan` resolves it by genuinely walking the store | Yes, real pipeline (same as `dashboard-mock-drive.mjs`) | **Yes.** The only headless driver that can | No — pinned to a single device (`scripts/dashboard-plan-drive.mjs:117-118`) | No dashboard surface (see below) | Yes, full — sets `VMCP_REST_TIMER: 'on'` (`scripts/dashboard-plan-drive.mjs:115`) |

**The finding to take away:** `dashboard-sim` cannot express a prescription — its store
carries no plan data at all. If you need to check a plan-related visual (the header's
`sets x reps @ load` lockup, the rail's `upcoming` rows, the strip's `todo` columns),
use `dashboard-plan-drive.mjs` or a real device with a plan attached — `dashboard-sim`
and plain `dashboard-mock-drive` cannot show it.

**Cues have no dashboard surface at all, on any driver.** Coaching cues are spoken
audio (`system.speak`), not a rendered value — there is no `VMCP_CUES` / cue read-out
anywhere under `src/dashboard`. The dashboard's own "cue" language (the nav item's
live-session dot, the live-page `AlertCue` verdict badge) is unrelated UI terminology,
not the coaching-cue vocabulary from [`docs/vocabulary.md`](vocabulary.md).
