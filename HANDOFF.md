# Voltras Workspace — Handoff for Next Dev Session

Written end of 2026-05-04 session. Goal: pick up the next dev session with full context, hit as much of `WISHLIST.md` as possible, with two stated priorities: **dual-Voltras support** and **push-driven (channel-based) messaging**.

## State at handoff

### Working trees — DIRTY in two repos

Nothing has been committed from this session. Both repos build clean (typecheck/lint/test/build all green) but the trees have uncommitted in-flight work that should be reviewed and committed first.

**`voltra-node-sdk` (real path `/Users/hjewkes/Documents/projects/voltra-node-sdk`):**

- `src/sdk/voltra-manager.ts`, `package.json`, `scripts/inject-esm-require-shim.mjs` — fix for ESM `require is not defined` in BLE adapter factories. Build emits a `createRequire` shim into `dist/esm/sdk/voltra-manager.js` via post-build banner injector.
- `src/bluetooth/adapters/{node,native,types}.ts` — fix for `scan(timeout)` unit bug. Adapter doc said "seconds" but consumers (manager default `10000`, mobile `SCAN_DURATION = 5000`, MCP `timeoutMs`) all assumed ms. Removed `* 1000` multiplier in node + native adapters; updated typedoc.
- 267/267 tests passing.

**`voltras-mcp` (real path `/Users/hjewkes/Documents/projects/voltras-mcp`, workspace symlink `voltras-workspace/voltras-mcp`):**

- `package.json`, `package-lock.json` — `@voltras/node-sdk` dep points at local tarball: `file:../voltra-node-sdk/voltras-node-sdk-0.4.0.tgz`. Real publish needs to revert this and bump SDK version.
- `src/state/event-bridge.ts`, `src/state/live-state.ts` — bridge refactor. Replaced custom rep-cycle detector with `addSampleToSet` from workout-analytics (same primitive the mobile app uses). `LiveState.processSample(sample)` is the new entry point; bridge is ~30 lines, just feeds samples in. `onRepBoundary` and `onSetBoundary` are debug-only no-ops.
- `src/tools/set-tools.ts` — `set.start` calls `client.startRecording()` (Workout.GO motor engage), `set.end` calls `client.endSet()` (Workout.STOP). Plus the new `set.get(setId)` tool.
- `src/tools/server-tools.ts`, `schemas/server.ts` — new `server.health` tool. **Known issue:** `build`, `sdkVersion`, `analyticsVersion` return `'unknown'` because `require.resolve('@voltras/node-sdk/package.json')` fails (SDK's `exports` field doesn't list `./package.json`) and `git rev-parse` runs from claude-code's cwd which isn't a repo. Both are 5-min follow-ups, not blocking.
- `src/tools/debug-tools.ts`, `src/state/debug-buffer.ts`, `schemas/debug.ts` — new `debug.recent_frames` / `debug.recent_events` ring buffer tools (capacity 256, env override `VMCP_DEBUG_BUFFER_SIZE`).
- `WISHLIST.md` — primary input for next session, see below.
- `CLAUDE.md` (workspace root) — relaxed the "no file: links" rule to permit `npm link` / `npm pack` for in-flight iteration.
- 219/219 tests passing.

### Pre-flight checklist (run first thing next session)

```bash
# Verify both trees still build clean
cd /Users/hjewkes/Documents/projects/voltras-workspace/voltra-node-sdk && npm run typecheck && npm run lint && npm test -- --run && npm run build
cd /Users/hjewkes/Documents/projects/voltras-workspace/voltras-mcp && npm run typecheck && npm run lint && npm test -- --run && npm run build

# Decide: commit the in-flight work as separate logical commits, or stage as one?
# Suggested split:
#   voltra-node-sdk commit 1: ESM createRequire shim (fixes "require is not defined" under stock Node ESM)
#   voltra-node-sdk commit 2: scan timeout unit fix (ms not seconds)
#   voltras-mcp commit 1: bridge refactor — use addSampleToSet from workout-analytics
#   voltras-mcp commit 2: observability tools (server.health, set.get, debug.*)
#   voltras-mcp commit 3: WISHLIST + HANDOFF docs
# Tarball dep in voltras-mcp/package.json should NOT be committed — revert to ^0.4.x range and rely on a real SDK publish + bump.
```

## Priority work for next session

### P0 — Dual Voltras support (user's #1 priority)

**Why:** Bilateral exercises (chest flies, single-arm asymmetry, partner training) require two devices controlled in lockstep. Workaround today is two MCP server instances with namespaced tools, which is clunky and doesn't let one Claude conversation see both sides at once.

**Top of WISHLIST entry:** `## 2026-05-04 — Multi-device support in a single MCP` (search for it). Sketch in there is roughly correct. Key open questions:

1. **One logical set across both arms, or two parallel sets that share a session?** Affects schema and the coaching surface. Recommend **one logical bilateral set** with two streams of telemetry — that's how a chest fly is conceptually one rep, not two.
2. **`ServerState` shape:** `Map<slotId, { manager, client, live }>` or fixed `slots: { left, right }`? Map is more flexible (3+ devices for partner training, future), fixed is simpler. Lean toward Map but cap to 2 in initial release.
3. **Tool routing:** every device/set/session tool gains an optional `slot` argument. Default to "the only connected slot" when unambiguous so single-device flows don't get noisier.
4. **SDK already supports multi-device.** `VoltraManager.clients: Map<string, VoltraClient>` exists. The MCP layer is what's single-tenant. Good news — most of the work is in voltras-mcp, not the SDK.
5. **Bilateral metrics pipeline** (`metrics.compute` for asymmetry — per-side velocity loss, ROM mismatch, force imbalance). This is workout-analytics-side work; could be deferred to a second wave if scope gets too big.
6. **Event bridge** subscribes one client today; needs per-slot subscriptions with slot-tagged events.

**Suggested execution order:**

1. Refactor `ServerState` to `slots: Map<slotId, SlotState>` keyed by slot ID. Default slot = `'primary'` for backward compat with single-device flows.
2. Update tool schemas to accept optional `slot` arg.
3. Update `device.scan` / `device.connect` to populate slots; first-connected gets `'left'`, second gets `'right'` by default (override-able).
4. Update event bridge to fan out per-slot, tag events.
5. Add `metrics.compute bilateral.set` pipeline (NEW workout-analytics work) — consumes the two slot-tagged sets and emits asymmetry metrics.
6. Test with the mock adapter first (instantiate two mock managers); then on real hardware.

**Test plan must include** a chest-fly-shaped scenario in the mock adapter — left and right arms producing parallel rep streams with controllable asymmetry to validate the bilateral pipeline.

### P0 — Push-driven set lifecycle / channel-based messaging (user's #2 priority)

**Why:** Today the user has to type "done" between sets and "go" after a rest timer. The MCP knows when reps complete and when timers fire — there's no reason it can't push these to PT Claude and skip the manual handoff.

**Top of WISHLIST entry:** `## 2026-05-04 — Push-driven set lifecycle (MCP → PT Claude callbacks)`. Reading order:

1. **First investigate**: does Claude Code's MCP integration surface `notifications/resource_updated` to the model as user-turn input today? The bridge already emits these via `event-bridge.ts:notify()` for `voltra://set/active`, etc. If yes, half the work is "just consume the notifications correctly" — write a sub-agent task to test this empirically before designing anything new.
2. **If the runtime supports push**, the architecture is: `set.start({watch: { stopOn, notifyOn }})` registers triggers; bridge evaluates them on each rep finalization in `LiveState.processSample`; matching triggers fire MCP notifications. Coach gets a wakeup turn when a trigger fires.
3. **If the runtime doesn't support push**, the fallback is a long-running `set.wait_for_event` tool that blocks until any registered trigger fires (or timeout). Same blocking-call problem as `timer.wait` today, but with a clear "tap me when X happens" semantic. Document the same `taskSupport: forbidden` constraint that bites timer.wait.
4. **Trigger DSL** sketch is in WISHLIST. Start with the most common: `rep_count_reached`, `set_ended_by_device` (user pressed end on Voltra UI), `idle_timeout_ms`. Add `velocity_loss_exceeded` once we trust the per-rep velocity stream.
5. **Same architecture solves the rest-timer-up case.** `timer.wait` becomes `timer.start({durationMs, onComplete: <event-spec>})` — fires a notification when done instead of blocking the conversation.

**Tradeoff to flag:** the user wants ergonomics; the implementer wants correctness. Push-driven flows are easy to break with race conditions (rep finalization mid-flight when set.end fires, network jitter, etc.). The first cut should err toward conservative — only fire triggers from finalized state, never speculative.

## Remaining WISHLIST items (priority-sorted)

After the two P0s above, in rough order of value:

1. **Tool consolidation** (`set.summary`, `device.configure`) — cuts ~30 round-trips per session. Pure ergonomics win, no architectural risk.
2. **Pipeline-level rep-quality flags + start/end position metrics** — surfaces the "rep-1 setup pause" and "trading depth for stretch" patterns automatically, instead of the coach rediscovering them every set.
3. **Rep-1 setup-pause artifact** in workout-analytics — fix the phase misclassification at the analytics layer (option 1: trim leading low-velocity prefix; option 2: reclassify HOLD-during-rep). Lower priority but blocks reliable VBT analysis on cable exercises.
4. **Position metrics are setup-relative** — adds per-session calibration anchors or velocity-vs-ROM-percentile output to workout-analytics. Setup-invariant metrics are what'll make day-to-day session comparisons meaningful.
5. **`session.fatigue` ramp-progression bug** — the `velocityRecoveryPct` field returns garbage on load-progression sessions. Detect session structure and skip/normalize.
6. **No warmup-vs-working set distinction** — recommend coach-side `setIds` filter on session pipelines (cheapest), `set.start { intent }` as long-term cleaner answer.
7. **`session.strength` 1RM opacity** — expose contributing sets, per-set estimates, method choice in the output.
8. **Exercise catalog is empty** — `workout-analytics/src/exercises/data/catalog.json` is `[]`. WISHLIST has a complete first-entry seed (single-arm cable lat pulldown) ready to drop in. Recommend bundling with the next workout-analytics change rather than standalone.

## Cross-cutting context the next session needs

### How to edit files in this repo (ownership hook quirk)

There's a pre-tool-use hook that restricts file edits to specific paths within `voltras-workspace`. Two gotchas:

1. **Use the workspace-symlinked path, not the canonical path.** `Edit` on `/Users/hjewkes/Documents/projects/voltras-mcp/...` is BLOCKED. Use `/Users/hjewkes/Documents/projects/voltras-workspace/voltras-mcp/...` instead. Same goes for `voltra-node-sdk`, `workout-analytics`, etc.
2. **Workspace root `CLAUDE.md` requires hook bypass.** Edits to `voltras-workspace/CLAUDE.md` are blocked by the same hook. If you need to edit it, ask the user.

### How to ship SDK/analytics changes through to the running MCP

Same drill we used twice this session:

```bash
cd /Users/hjewkes/Documents/projects/voltras-workspace/voltra-node-sdk
# make changes
npm run typecheck && npm test -- --run && npm run build && npm pack
# tarball lands at voltras-node-sdk-0.4.0.tgz

cd /Users/hjewkes/Documents/projects/voltras-workspace/voltras-mcp
npm install ../voltra-node-sdk/voltras-node-sdk-0.4.0.tgz
npm run build
# user restarts MCP via /mcp
```

For workout-analytics, identical pattern with `@voltras/workout-analytics` as the package name.

### Audit confirmed voltras-mcp is structurally thin

Late in this session a sub-agent audited every non-test file in `voltras-mcp/src/` against the SDK and analytics for duplicated business logic. **Zero high or medium findings post-bridge-fix.** The MCP is a clean transport adapter today. New work (multi-device, push lifecycle) should preserve that — keep workflow logic in workout-analytics or in PT Claude, not in voltras-mcp.

### Coaching workaround until the rep-1 artifact is fixed upstream

PT Claude should compute set-level metrics from reps 2..N (skip rep 1) and surface a note explaining why. The setup-pause is a real pattern, not a one-off, and it bit every set in this session. Apply the workaround at the MCP layer until `vbt.set` knows to flag/trim.

### Unfinished testing on the bridge fix

Real-device validation only happened on right-arm reps in this session. Should re-validate after dual-voltras work lands by running a left-arm-only set, then a bilateral set, then a chest fly. Mock-adapter integration tests still pass but they don't exercise real frame phase transitions.
