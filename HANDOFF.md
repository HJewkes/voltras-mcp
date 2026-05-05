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

**Status (2026-05-04 end of session): architecture validated and partially shipped.**

`notifications/resource_updated` is NOT delivered to the model in Claude Code (cache hint only — verified empirically via `debug.push_test_channel` smoke test). The working push primitive is `notifications/claude/channel`, which delivers events inline to the live conversation as `<channel>` XML tags. Reference impl: `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/server.ts` (and `telegram/`, `discord/`).

**What's wired today** (commit `1b238ae` on `feat/observability-and-bridge-refactor`, then bug-fix follow-up):

- `experimental: { 'claude/channel': {} }` declared in capabilities (`src/server.ts`).
- `McpChannelPublisher` wraps `server.server.notification(...)` fire-and-forget (`src/state/channel-publisher.ts`).
- Bridge emits `rep_finalized` events when a rep closes (length N→N+1 for N≥1; rep N is covered by `set_ended` instead — see "UX quirk" below).
- `set.start`/`set.end` emit `set_started`/`set_ended` events with set ID, rep count, duration.
- `debug.push_test_channel` tool for smoke testing without real hardware.

**How to launch with channels enabled** (the flag is hidden from `claude --help` because it's `--dangerously-`-prefixed; the doc page lives at https://code.claude.com/docs/en/channels-reference):

```bash
claude --dangerously-load-development-channels server:voltras
```

The `server:<name>` form works for plain `.mcp.json` servers — no plugin packaging required. Use `--channels plugin:<name>@<marketplace>` only after the MCP is wrapped as a plugin and published. The dev flag is gated behind the research-preview status (Claude Code v2.1.80+).

**UX quirk to know about:** `rep_finalized` fires when the _next_ rep begins, not when the current one ends. This is intrinsic to `addSampleToSet`'s ECC→CONC boundary detection — a rep can't be confirmed "done" until the next concentric pull rules out a long pause. The terminal rep (rep N) never sees a phase transition that closes it; `set.end` finalizes it via `completeSet()` and the `set_ended` channel event covers that case. Net coverage: reps 1..N-1 fire `rep_finalized` (with small lag); rep N rides on `set_ended`. The coaching surface should treat each `rep_finalized` event as "user just started a new rep, here's the prior one's metrics" rather than "user just released the cable."

**Remaining work** (in rough order of value, all on top of the existing branch):

1. **Trigger DSL** — `set.start({ watch: { stopOn, notifyOn } })`. Server-side filter so the coach only wakes on events it cares about. Sketch in WISHLIST. Start narrow: `rep_count_reached`, `set_ended_by_device`, `idle_timeout_ms`. Add `velocity_loss_exceeded` once per-rep velocity is trusted.
2. **`timer.wait` push variant** — replace the blocking long-poll with `timer.start({ durationMs, onComplete: <event-spec> })`. Fires a channel event when done; conversation isn't held open.
3. **Reliability story** — Claude Code v2.1.128 delivers channels reliably with the dev flag, but the brain MCP's tool description says "not reliable in all Claude Code versions." Worth a defensive guard: if channels aren't enabled (no `--dangerously-load-development-channels`), the publisher silently no-ops today. We may want a one-time log line at startup when the host doesn't acknowledge the capability so users notice missing push-driven flow.
4. **Plugin-wrap for distribution** — once the trigger DSL stabilizes, wrap voltras-mcp as a plugin (drop a `.claude-plugin/plugin.json` + `.mcp.json` into the repo per the fakechat reference). Lets users install with `--channels plugin:voltras@<marketplace>` instead of the dev flag.

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
