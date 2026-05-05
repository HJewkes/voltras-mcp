# Voltras Workspace — Handoff for Next Dev Session

Written end of 2026-05-04 session. Push architecture is complete and shipped. SDK 0.4.1 is published. **Open work: dual-Voltras (P0), then sprint 3 push polish, then the workout-analytics quality items.**

## State at handoff

### Working trees — both clean

**`voltra-node-sdk`** (real path: `/Users/hjewkes/Documents/projects/voltra-node-sdk`)

- **v0.4.1 published to npm** via OIDC trusted publishing (Release workflow fires on `v*` tag push, not on main commits — keep this in mind for future bumps).
- 267 tests passing. main is at `d33d00c` (squash-merge of #31).
- The two fixes shipped in 0.4.1: ESM `createRequire` shim for the lazy adapter factories; `BLEAdapter.scan(timeout)` consistently treats the value as milliseconds.

**`voltras-mcp`** (real path: `/Users/hjewkes/Documents/projects/voltras-mcp`, workspace symlink: `voltras-workspace/voltras-mcp`)

- Branch `feat/observability-and-bridge-refactor` (15 commits ahead of main) is **pushed** and open as **[PR #3](https://github.com/HJewkes/voltras-mcp/pull/3)** awaiting review/merge.
- 319 tests passing. Builds clean. Consumes `@voltras/node-sdk@^0.4.1` from npm.
- Channels validated end-to-end (`debug.push_test_channel` smoke-tested in a fresh `--dangerously-load-development-channels server:voltras` session).

### Pre-flight checklist

```bash
# Verify both trees still build clean
cd /Users/hjewkes/Documents/projects/voltras-workspace/voltra-node-sdk \
  && npm run typecheck && npm run lint && npm test -- --run && npm run build
cd /Users/hjewkes/Documents/projects/voltras-workspace/voltras-mcp \
  && npm run typecheck && npm run lint && npm run format:check && npm test -- --run && npm run build
```

If MCP PR #3 hasn't merged yet, decide whether to merge it before starting new work or to branch from `feat/observability-and-bridge-refactor` directly. Recommend **merging first** so the new work is on a clean main — the PR is large but each commit tells a coherent story; review can be commit-by-commit.

## Push architecture — what's shipped, what's left

### Events (sprints 1A, 1B, 2 — all on the merged branch)

| Event                    | Trigger                                               | Auto-stop?                        |
| ------------------------ | ----------------------------------------------------- | --------------------------------- |
| `rep_finalized`          | Each ECC→CONC transition closes the prior rep         | —                                 |
| `set_started`            | `set.start` tool (carries previous-set summary)       | —                                 |
| `set_ended`              | `set.end` tool (carries full rep array + VBT summary) | —                                 |
| `set_ended_by_device`    | `onSetBoundary` outside grace window                  | implicit (device already stopped) |
| `connection_changed`     | Any `onConnectionStateChange` transition              | —                                 |
| `timer_complete`         | `timer.start` duration elapsed                        | —                                 |
| `set_target_reached`     | `rep_count_reached` trigger matches                   | optional via stopOn               |
| `velocity_loss_exceeded` | `velocity_loss_exceeded` trigger matches              | optional via stopOn               |
| `idle_timeout`           | `idle_timeout_ms` watchdog fires                      | optional via stopOn               |

Trigger DSL: `set.start({ watch: { stopOn[], notifyOn[] } })`. `stopOn` matches auto-stop the set (firing the trigger event AND `set_ended` with `partial_reason: 'auto_stopped'` and `auto_stop_cause: <trigger.type>`); `notifyOn` matches just fire the trigger event with `auto_stopped: 'false'`. Triggers dedupe per `(type, value)`. Velocity baseline is the highest peak concentric velocity seen so far in the set (sidesteps the rep-1 setup-pause artifact).

### Launching with channels enabled

```bash
claude --dangerously-load-development-channels server:voltras
# or via the bundled launcher:
scripts/voltra-pt
```

The flag is hidden from `claude --help` (research-preview, requires Claude Code v2.1.80+). Without the flag, channel events are silently dropped at the host but the rest of the MCP keeps working over polling. README §Push events documents the full surface.

### UX quirk to know about

`rep_finalized` fires when the _next_ rep begins, not when the current one ends — intrinsic to `addSampleToSet`'s ECC→CONC boundary detection. The terminal rep (rep N) never sees a closing transition; `set.end` finalizes it via `completeSet()` and the `set_ended` event covers that case. Coaching surfaces should treat each `rep_finalized` event as "user just started a new rep, here's the prior one's metrics."

### Remaining push work (sprint 3, lower priority than P0)

1. **Reliability log at startup** — when the host doesn't acknowledge the `claude/channel` capability (likely because the user forgot the dev flag), emit a one-time stderr log line so missing push-driven flow is noticeable. Currently the publisher silently no-ops.
2. **Plugin-wrap for distribution** — drop `.claude-plugin/plugin.json` + `.mcp.json` per the fakechat reference at `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/`. Lets users install via marketplace and use `--channels plugin:voltras@<marketplace>` instead of the dev flag.
3. **Channel suppression API** — `set.start({ silent: true })` (or per-event-type filter) for noisy warmup phases. Defer until in-conversation noise is actually a problem; we haven't observed it yet.
4. **Bilateral channel meta** — pairs with P0 #1 below. Once dual-Voltras lands, all per-slot events should carry `slot` in meta; trigger DSL needs `bilateral_asymmetry` etc. Plan in tandem with the dual-Voltras schema work.

## Priority work for next session

### P0 — Dual Voltras support

**Why:** Bilateral exercises (chest flies, single-arm asymmetry, partner training) need two devices controlled in lockstep. Today the workaround is two MCP server instances with namespaced tools, which is clunky and prevents one Claude conversation from seeing both sides at once.

**Top of WISHLIST entry:** `## 2026-05-04 — Multi-device support in a single MCP`. Sketch is roughly correct.

Key open questions:

1. **One logical set across both arms, or two parallel sets that share a session?** Recommend **one logical bilateral set** with two streams of telemetry — that's how a chest fly is conceptually one rep, not two.
2. **`ServerState` shape:** `Map<slotId, SlotState>` (flexible) vs fixed `slots: { left, right }` (simpler). Lean toward `Map` but cap to 2 in initial release.
3. **Tool routing:** every device/set/session tool gains an optional `slot` argument; default to "the only connected slot" when unambiguous.
4. **SDK already supports multi-device** — `VoltraManager.clients: Map<string, VoltraClient>` exists. The MCP layer is single-tenant; that's where the work is.
5. **Bilateral metrics pipeline** in workout-analytics — `metrics.compute bilateral.set` for per-side velocity loss, ROM mismatch, force imbalance. Could defer to a second wave if scope grows.
6. **Event bridge** subscribes one client today; needs per-slot subscriptions with slot-tagged events + slot meta on every channel publish.
7. **Channel events** must carry `slot` meta key when running multi-device. The current single-slot wiring should default to a literal `slot: 'primary'` so single-device flows are unaffected.

**Suggested execution order:**

1. Refactor `ServerState` to `slots: Map<slotId, SlotState>`. Default slot = `'primary'` for backward compat.
2. Update tool schemas to accept optional `slot` arg.
3. Update `device.scan` / `device.connect` to populate slots; first-connected gets `'left'`, second gets `'right'` by default (override-able).
4. Update event bridge to fan out per-slot, tag events with `slot` meta.
5. Add `metrics.compute bilateral.set` pipeline (workout-analytics work).
6. Test with mock adapter first (instantiate two mock managers); then real hardware.

**Test plan must include** a chest-fly-shaped scenario in the mock adapter — left and right arms producing parallel rep streams with controllable asymmetry to validate the bilateral pipeline.

## Remaining WISHLIST items (priority-sorted)

After P0 dual-Voltras and sprint 3 polish, the highest-value remaining items live in `workout-analytics`. The MCP-side ergonomics wins are mostly absorbed by the channel-payload enrichment (e.g., `set_ended` already carries the rep table + VBT summary, so `set.summary` is largely obsoleted).

1. **Rep-1 setup-pause artifact** (workout-analytics) — fix the phase misclassification at the analytics layer. Today rep-1 metrics are unreliable on cable exercises (the user's setup pause is being captured as part of the concentric phase). Two paths: trim leading low-velocity prefix, OR reclassify HOLD-during-rep. **Blocks reliable VBT analysis on real hardware** — coaches today have to skip rep 1 manually. High value.
2. **Pipeline-level rep-quality flags + start/end position metrics** — surfaces the "rep-1 setup pause" and "trading depth for stretch" patterns automatically. Couples with #1; could be a follow-up that exposes flags the rep-1 fix produces.
3. **Position metrics are setup-relative, not movement-relative** (workout-analytics) — adds per-session calibration anchors or velocity-vs-ROM-percentile output. Setup-invariant metrics are what'll make day-to-day session comparisons meaningful.
4. **`session.fatigue` ramp-progression bug** (workout-analytics) — the `velocityRecoveryPct` field returns garbage on load-progression sessions because the pipeline assumes same-weight-across-sets. Detect session structure and skip/normalize.
5. **No warmup-vs-working set distinction** — coach-side `setIds` filter on session pipelines (cheapest), or `set.start({ intent: 'warmup' | 'working' | ... })` as the cleaner long-term answer.
6. **`session.strength` 1RM opacity** — expose contributing sets, per-set estimates, and method choice (Epley/Brzycki/regression) in the output. Lets the coach explain _why_ the number.
7. **`device.configure({ weight?, mode?, eccentric?, chains? })`** — atomic multi-parameter device update. Replaces the 3 sequential `device.set_*` calls every weight change. Note: `set.summary` from the original wishlist is mostly obsoleted by the enriched `set_ended` channel payload — `device.configure` is the residual ergonomics win.
8. **Exercise catalog seed** (workout-analytics) — `src/exercises/data/catalog.json` is `[]`. WISHLIST has a complete first-entry seed (single-arm cable lat pulldown) ready to drop in. Bundle with the next workout-analytics change.

## Cross-cutting context the next session needs

### File-edit ownership hook

A pre-tool-use hook restricts edits to paths under `voltras-workspace`. Two gotchas:

1. **Use the workspace-symlinked path, not the canonical path.** `Edit` on `/Users/hjewkes/Documents/projects/voltras-mcp/...` is BLOCKED. Use `/Users/hjewkes/Documents/projects/voltras-workspace/voltras-mcp/...` instead. Same goes for `voltra-node-sdk`, `workout-analytics`, etc.
2. **Workspace root `CLAUDE.md` requires hook bypass.** Edits to `voltras-workspace/CLAUDE.md` are blocked by the same hook. Ask the user if you need to change it.

### Shipping SDK changes through to the running MCP

Now that 0.4.1 is published, the standard flow is:

```bash
cd /Users/hjewkes/Documents/projects/voltras-workspace/voltra-node-sdk
# make changes
npm run typecheck && npm test -- --run && npm run build
# bump version in package.json + CHANGELOG.md
git commit -m "chore: release v0.4.X"
# open PR, merge to main
git fetch origin main && git tag v0.4.X origin/main && git push origin v0.4.X
# Release workflow auto-publishes via OIDC

cd /Users/hjewkes/Documents/projects/voltras-workspace/voltras-mcp
npm install --save @voltras/node-sdk@^0.4.X  # or rely on `^0.4.0` semver bump
npm run build
# user restarts MCP via /mcp
```

For workout-analytics, identical pattern with `@voltras/workout-analytics` as the package name. The local-tarball install (`file:../voltra-node-sdk/...tgz`) is OK for in-flight iteration but should NEVER be committed — revert before opening a PR. Workspace `CLAUDE.md` already permits this for `npm pack` but flags the commit hazard.

### voltras-mcp is structurally thin

A sub-agent in the prior session audited every non-test file in `voltras-mcp/src/` against the SDK and analytics for duplicated business logic. **Zero high or medium findings post-bridge-fix.** New work (multi-device, additional pipelines) should preserve that — keep workflow logic in workout-analytics or in PT Claude, not in voltras-mcp.

### Coaching workaround until the rep-1 artifact is fixed upstream

PT Claude should compute set-level metrics from reps 2..N (skip rep 1) and surface a note explaining why. The setup-pause is a real pattern that bit every set in the last real-hardware session. Apply the workaround at the coaching surface until `vbt.set` knows to flag/trim. The enriched `set_ended` channel payload makes this trivial — its `vbt_summary` is computed from all reps; the coach can re-aggregate excluding rep 0.

### Unfinished testing on the bridge fix

Real-device validation only happened on right-arm reps. Should re-validate after dual-Voltras work lands by running a left-arm-only set, then a bilateral set, then a chest fly. Mock-adapter integration tests still pass but they don't exercise real frame phase transitions.

### Known minor follow-ups (all on the merged branch, none blocking)

- **`server.health` returns `'unknown'` for build/sdkVersion/analyticsVersion** because `require.resolve('@voltras/node-sdk/package.json')` fails (SDK's `exports` field doesn't list `./package.json`) and `git rev-parse` runs from claude-code's cwd which isn't a repo. Both are 5-min follow-ups.
- **`set.start({ watch: { stopOn: [{ type: 'idle_timeout_ms', value: 1000 }, ...] } })`** uses smallest-wins for the watchdog timer (one watchdog per set). If a future user wants multiple separate idle thresholds, extend `SetWatchdog` to per-spec timers.
