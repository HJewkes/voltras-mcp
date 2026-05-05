# voltras-mcp Wishlist

Capability gaps surfaced during real use. Not prioritized; not a roadmap. Add new items at the top with a date and the workout/situation that surfaced them.

## 2026-05-05 — CRITICAL: device commands route to the wrong peripheral when two slots are connected (dual-Voltras blocker)

> **Status (2026-05-05):** Fix open as [voltra-node-sdk PR #32](https://github.com/HJewkes/voltra-node-sdk/pull/32), targeting release `0.4.2`. The SDK now builds a fresh BLE adapter per `manager.connect(device)` instead of reusing a singleton. Single-device flows unchanged on both Node and web. Multi-device on web is deferred to 0.5.0 (manager-owns-devices refactor). Once 0.4.2 publishes, voltras-mcp bumps to `^0.4.2` and we re-run the bilateral routing smoke test on real hardware.

**Use case:** Bilateral routing smoke test against `feat/dual-voltras-slots` build. Two Voltras devices paired:

- `slot: 'left'` → VTR-212006 (`C4A88FC8-...`)
- `slot: 'right'` → VTR-097082 (`621A7B7D-...`)

`device.connect({slot: 'left', deviceId: VTR-212006})` and `device.connect({slot: 'right', deviceId: VTR-097082})` both returned `{ok: true}`. `device.get_state({slot})` correctly returned each slot's distinct deviceId. **Slot bookkeeping in voltras-mcp is correct.**

Then `device.set_weight({slot: 'left', lbs: 35})` and `device.set_weight({slot: 'right', lbs: 35})` both returned `{ok: true}`. Subsequent `device.get_state` for each slot reported `weightLbs: 35` consistently. **But on the physical units:** the right-slot device (VTR-097082) updated to 35 lbs as expected; the left-slot device (VTR-212006) stayed at 55 lbs (the value left over from the prior single-device session) and was inactive.

**Diagnosis (empirically confirmed via A/B test):** in a follow-up experiment we connected the devices in reverse order (right=VTR-097082 first, left=VTR-212006 second/most-recent), then sent four parallel writes with distinguishing values:

| Command                                            | Expected target | Actual physical result                     |
| -------------------------------------------------- | --------------- | ------------------------------------------ |
| `set_weight({slot: 'left', lbs: 30})`              | VTR-212006      | VTR-212006 ended at 30 lbs ✓               |
| `set_weight({slot: 'right', lbs: 40})`             | VTR-097082      | VTR-097082 unchanged (no write reached it) |
| `set_mode({slot: 'left', mode: 'ResistanceBand'})` | VTR-212006      | VTR-212006 ended in Damper mode ✗          |
| `set_mode({slot: 'right', mode: 'Damper'})`        | VTR-097082      | VTR-097082 unchanged (no write reached it) |

Decoded: **all four writes landed on the most-recently-connected peripheral (VTR-212006).** Last-write-wins per characteristic (the two weight writes hit left in some order; final value reflects whichever resolved last). VTR-097082 received zero commands.

The per-slot `weightLbs`/`trainingMode` cache in voltras-mcp's `LiveState` updates locally on every successful tool call regardless, masking the failure at the get_state read path.

**Where the bug lives — confirmed in `voltra-node-sdk`, not voltras-mcp:**

- The MCP's command path (`src/tools/device-tools.ts`) correctly routes via `getSlot(state, slotId).client.setWeight(lbs)`. The two slots hold distinct `VoltraClient` instances returned from `manager.connect(device)`. The MCP-side slot bookkeeping is fine — the channel-publish path also routes correctly per slot (proven by slot-tagged set_started/set_ended/connection_changed events on real hardware).
- The SDK's `VoltraClient` instances **must be sharing an underlying peripheral reference** — or the BLE adapter has a "currently active peripheral" singleton that gets clobbered on each new `manager.connect`. The bilateral mock test passes because the mock manager hands out genuinely independent fake clients; the real BLE adapter does not.

**Investigation paths in voltra-node-sdk:**

1. Open `VoltraManager.connect` — what state does it set on the BLE adapter? Does it call something like `adapter.setActivePeripheral()` that's a singleton?
2. Open `VoltraClient.setWeight` (or whatever the write method is) — does it hold its own peripheral reference, or look up "the" peripheral on the manager / adapter?
3. Check the underlying BLE library wiring (Noble?) — Noble supports multiple peripherals natively, but the SDK's wrapper may not.
4. Audit the `manager.clients: Map<string, VoltraClient>` claim from the architecture report — verify each client truly has its own peripheral binding, not a shared one.

**What's NOT broken (proven on this real-hardware test):**

- ✅ Two simultaneous BLE peripheral connections on macOS work (`device.get_state` for both slots returns correct deviceIds in parallel).
- ✅ Slot lifecycle in voltras-mcp: `device.connect({slot})` creates new slots; `device.disconnect({slot})` removes them; `device.get_state({slot})` reads correctly.
- ✅ Slot-tagged channel events fire correctly on real hardware: `set_started`, `set_ended`, `connection_changed` all arrived with `slot="left"` or `slot="right"` matching the originating slot. The bilateral mock test prediction holds.
- ✅ Per-slot session and set lifecycle: distinct setIds and sessionIds maintained across slots; ending one slot's set doesn't affect the other.

**Why this is the actual blocker for dual-Voltras:** without correct command routing, the user can't independently configure (weight, mode, eccentric) the two devices. Bilateral exercises with asymmetric loading (e.g. unilateral imbalance correction) become impossible. Even a basic chest fly with matched loads becomes risky because the second device might not have actually received the weight command.

**Mitigation ideas to discuss:**

1. SDK fix is the proper path. Until then, voltras-mcp could verify writes succeeded by reading back state from the device after each write, with a small delay. Slow but at least surfaces the failure.
2. Or: the MCP's `set_weight` handler could refuse to operate on a non-primary slot until the SDK is verified correct. Surfaces the limitation explicitly.

## 2026-05-05 — `device.scan` returns only one device per call even when multiple are advertising

**Use case:** Same bilateral test session. Both VTR-212006 and VTR-097082 were powered and advertising. Two consecutive `device.scan({timeoutMs: 15000})` calls each returned a single-element array — alternating between the two devices on each call. The schema returns a `devices: []` array, implying batch discovery, but the implementation appears to return only the first peripheral found.

**Workable for now** by calling scan repeatedly until the desired count is collected, or by scanning, connecting, scanning again. But the schema/implementation mismatch is a footgun and impacts UX (the tool description should be honest about per-call limits, or the scan should accumulate over its full timeout).

**Investigation path:** the BLE adapter's scan implementation in voltra-node-sdk. Suspect it returns on first peripheral discovery rather than waiting out the full timeout window to accumulate.

## 2026-05-05 — CRITICAL: SDK loses the active set after exactly 2 rep_boundary events (real-hardware blocker)

> **Status (2026-05-05):** Path forward identified. The `RepBoundary` BLE message is a stateless 4-byte type header (no rep counter in the payload), and the SDK has no client-side state machine to derive rep count from frames — it relies on the device firmware to count, but the firmware emits an under-specified tick. The fix path is **not** to crack the existing protocol; it's to land voltra-private's in-flight `vendor-message-rep-set-telemetry` PR (PR #7 of a 7-PR stack) which adds a per-frame vendor message carrying authoritative `motionPhase`, `setCounter`, and `repCount` (uint16 BE). Once that stack merges and the SDK's `protocol-data.generated.ts` is regenerated, refactor the SDK's notification dispatcher to count from the vendor frame instead of trusting the stateless boundary signal. Bug is gated on the private-repo stack landing — no firmware doc spelunking needed.

**Use case:** Left-arm bridge validation. Two sets (35 lb warmup, 55 lb working). On both sets the user did 5–8 reps; the system registered exactly 2. The bug is reproducible across loads and is **upstream of voltras-mcp** — the bridge faithfully relays what the SDK emits.

**Bridge debug-event capture for the working set** (timestamps in ms relative to set start):

```
t+21513  rep_boundary  repsSoFar: 1    rep 1 finalized (correct)
t+23852  rep_boundary  repsSoFar: 1    second event — should be repsSoFar: 2
t+24303  set_boundary  hadActiveSet: true     SDK declares set ended autonomously
t+24759  rep_boundary  repsSoFar: 0    "ghost" — SDK has dropped the set
t+25389  set_boundary  hadActiveSet: false
... ~20s of continuing rep_boundary/set_boundary pairs (the user doing reps 3–8) all with repsSoFar=0, hadActiveSet=false
```

The 35-lb warmup set shows the identical pattern. **Deterministic at 2 reps.**

**Two distinct SDK bugs in `voltra-node-sdk`:**

1. **Rep-boundary counter doesn't advance past 1.** Two `rep_boundary` events fire close together (~2.3s apart in both sets) and both report `repsSoFar: 1`. Either the SDK is double-firing on a single rep transition, or it's counting both ECC→CONC and CONC→ECC as rep boundaries and the `repsSoFar` field reflects only one direction.
2. **Stuck-state autonomous set termination.** Immediately after the duplicate rep_boundary, a `set_boundary` fires with `hadActiveSet: true` and the SDK marks the set ended. The voltras-mcp event bridge interprets this as "user pressed Stop on the unit" — surfaced to the user as `partial_reason: 'device_signal'`, which in this case is a false positive.

**Subsequent ghost events.** After the SDK has dropped the set, the device keeps emitting `rep_boundary` and `set_boundary` signals (the user is still repping). The SDK passes them through but with `hadActiveSet: false` / `repsSoFar: 0`. Useful evidence that the device's rep detection is fine — the SDK's _active-set state machine_ is what's failing.

**Investigation paths in the SDK:**

- Find the rep_boundary emission logic (likely in the live-state / sample processor). Why does it fire twice for what looks like one rep? Add logging on the underlying frame-stream signal that triggers it.
- Find the autonomous set-end heuristic. Is it duration-based, signal-based, or pattern-based on the rep boundaries? It should not be triggering after only 2 reps in a normal set.
- Check whether the device protocol has a distinct "user pressed Stop" signal vs an inferred set-end. Today the bridge treats any `onSetBoundary` outside the grace window as Stop — that may be wrong if the SDK is firing set_boundary for reasons other than a Stop press.

**Mitigations to consider while the SDK is fixed:**

- Bridge-layer sanity check before publishing `set_ended_by_device`: if rep count is suspiciously low (< 3?) or set duration is short, log a warning instead of declaring the set closed. Avoids losing data.
- Bridge-layer "phantom-rep recovery": if `rep_boundary` events keep arriving after a set has been declared ended, surface them as a recovery channel event so the coach can prompt the user.

**Why this is a P0 blocker for the dual-Voltras work:** if single-arm rep counting tops out at 2, bilateral coaching can't even validate the simplest claim ("did the user complete the set"). Every real-hardware test we've done has been corrupted by this. The bridge fix shipped on `feat/observability-and-bridge-refactor` is correctly relaying the broken signal — the fix is needed one layer down, in the SDK.

## 2026-05-05 — Channel payload velocity / ROM units appear mislabeled

**Use case:** Left-arm bridge validation set, single-arm cable lat pulldown at 35 lbs. The `rep_finalized` channel event reported:

```
peak_concentric_velocity: 20      // rep 1
peak_eccentric_velocity:  131
peak_concentric_velocity: 293     // rep 2
rom_m: 1049                       // rep 1
rom_m: 858                        // rep 2
```

The field name `rom_m` implies meters; 1049 m of pull stroke is impossible for a cable lat pulldown (~1 m would be realistic). Likewise the `peak_*_velocity` values plausibly fit mm/s (0.293 m/s peak concentric on a warmup is a normal VBT reading) — but the field naming doesn't disambiguate.

**Possible fixes:**

1. Rename channel fields to include unit suffixes: `rom_mm`, `peak_concentric_velocity_mm_s`, etc. Self-documenting; no behavior change.
2. Or convert to SI at the bridge boundary: divide ROM by 1000, divide velocities by 1000, keep the field names as-is.
3. Or add a `units` block to the rep payload: `{ velocity: "mm/s", rom: "mm", force: "N" }`.

Trace path: SDK frame → `LiveState.appendRep` → bridge → channel publish. The conversion (or lack of) is somewhere in that chain. Verify by reading what the SDK's frame protocol declares as native units, then either match or convert at the boundary explicitly.

**Why it matters:** every consumer of `rep_finalized` (PT Claude, future plugins) has to know which wire format they're getting. Today it's a guessing game from the magnitude of the numbers.

## 2026-05-05 — `peak_force` reports 0 on real-hardware reps

**Use case:** Same left-arm bridge validation set. The `rep_finalized` event reported `peak_force: 0` on rep 1 of a 35 lb pull. Rep 2's eccentric came back 0/0 because the user racked the weight, but rep 1 was a normal-feeling pull and peak force should be roughly load-bearing × pull velocity, not zero. Likely a missed sensor field or unit-conversion path; could also be a bridge-payload issue where the field is being read from the wrong location in the frame.

**Investigate:** the SDK frame schema's force field, the LiveState rep aggregator's force handling, and the bridge payload assembly. The fact that the field is _present_ but `0` suggests the path is wired but the value isn't landing.

**Note:** this validation set was force-relevant only on rep 1 (rep 2 ended via Stop). Rerun on a longer set to get more data points before committing to a fix.

## 2026-05-05 — Historical-data lookup is unusable due to default frame-stream payload

**Use case:** Mid-session, asked "what did I do yesterday?" — `session.list` to find the session, then `session.get` on the most recent one. The response was 182,500 characters (the full per-frame sample stream across 5 sets / 41 reps). The token limit forced an out-of-band file read + jq projection just to surface the basics (exercise name, set count, weights, rep counts).

Compounding the problem: every per-rep summary field (`peakVelocity`, `meanVelocity`, `romMm`, `peakForceN`) came back `null`. The schema has the slots; the storage layer never populates them at finalize time, so coaching consumers have to call `metrics.compute vbt.set` per setId just to get data the device already computed during the live set.

**Three improvements, ranked by leverage:**

1. **Persist rep summaries at `set.end`.** The `set_ended` channel payload already carries `vbt_summary` (per the bridge fix shipped on the `feat/observability-and-bridge-refactor` branch). Wire that into the store so reads return useful data without a `metrics.compute` roundtrip. ~50 LOC in `finalizeSet`. Closes the "rep fields are null" gap directly.

2. **Add a `detail` enum to `session.get` / `set.get`.** Default to `'reps'` (per-rep summary, no frames). Levels:
   - `'summary'` — exercise, timestamps, set count, top working weight (no rep array)
   - `'reps'` — per-rep metrics, no frames (default — what coaching wants 95% of the time)
   - `'frames'` — adds the raw sample stream (debug / re-analysis only)

   Strictly a breaking change, but the frame stream is barely usable at this size and every real consumer re-derives metrics anyway.

3. **Enrich `session.list` with denormalized summary fields.** Include `setCount`, `topWeightLbs`, `totalReps`, `endedAt` (today the list returns just `{ id, startedAt, endedAt, exerciseName }`, forcing a follow-up `session.get` call to answer "how heavy did I go yesterday?"). With this change the answer's in one tool call.

Combined effect: typical coaching context lookup goes from ~182KB / 2 calls to ~2KB / 1 call, with no fidelity loss for the common case. The persistence change (#1) crosses SDK + MCP boundaries — the SDK's finalize path needs to surface the VBT summary fields the store will write.

## 2026-05-04 — `session.fatigue` doesn't handle ramp progressions (upstream: workout-analytics)

**Use case:** End of a 5-set lat pulldown progression at 20 → 35 → 55 → 75 → 90 lbs. `session.fatigue` returned:

```
{ level: 0.33, velocityRecoveryPct: 260, repDropPct: 11, isJunkVolume: false }
```

The `velocityRecoveryPct: 260%` is meaningless. It's reading "session-end velocity was 260% higher than session-start" — true, because every later set was at a heavier load with a different velocity baseline. The pipeline appears to assume same-weight-across-sets workout structure (where "recovery" between sets at fixed load is the actual signal). Ramp / progressive-load sessions break that assumption silently.

**What's needed:**

- Detect session structure: same-weight repeated, ramp progression, descending drop-set, mixed.
- Skip or recompute the `velocityRecoveryPct` field for non-same-weight sessions, OR normalize per-load (compute recovery only across sets that share the same weight).
- Surface session structure in the output so consumers know which fields are meaningful.

**Bonus:** the rest of the output was actually useful — `level: 0.33` and `isJunkVolume: false` are valid for a load-progression test. Just the recovery metric is the broken piece.

## 2026-05-04 — No warmup-vs-working set distinction in session-level pipelines

**Use case:** Same 5-set lat pulldown progression. The user knew sets 1–3 (20, 35, 55 lbs) were warmup territory and only sets 4–5 (75, 90 lbs) were anywhere near working weight. Session pipelines treated all 5 sets equally. This skews session-level metrics — averaging fatigue across warmup + working sets dilutes the real fatigue signal of the working sets.

**Three candidate solutions:**

1. **Set-level `intent` tag at `set.start`.** Add an optional `{ intent: 'warmup' | 'working' | 'amrap' | 'cooldown' }` to set.start. Session pipelines filter or weight by intent. Simple, requires user/coach to tag.
2. **Auto-classification from velocity-load curve.** A set is "working" if its mean concentric velocity falls below some fraction of the user's max-velocity-at-that-load (or below an absolute threshold appropriate for the exercise). Hard without per-user calibration.
3. **Coach (PT Claude) decides post-hoc which sets to feed into session pipelines.** No schema change needed — `session.fatigue` already accepts a session ID, but a `setIds: string[]` filter would let the coach scope the analysis. Cheapest implementation, defers the classification problem to the consumer.

Option 3 is the most pragmatic — analytics pipelines stay declarative, the coach handles intent. Option 1 is nicer long-term once we have a workout-plan abstraction. Option 2 is research-grade.

## 2026-05-04 — `session.strength` 1RM estimate is opaque about source-set selection

**Use case:** End of session, `session.strength` returned `{ estimated1RM: 114, confidence: 0.85, source: 'reps' }`. The number is plausible (Epley applied to 90 lbs × 8 reps yields ~114). But the pipeline doesn't expose:

- Which set(s) contributed to the estimate
- Why confidence is 0.85 (high because we had a multi-load curve to fit? low because only one set was near failure?)
- What the per-set 1RM estimates were (so we'd see whether they converge or diverge across loads)

**What's needed:** structured provenance in the output:

```jsonc
{
  "estimated1RM": 114,
  "confidence": 0.85,
  "source": "reps",
  "contributingSets": ["set-id-1", "set-id-2", ...],
  "perSetEstimates": [
    { "setId": "...", "weight": 90, "reps": 8, "estimate": 114, "weight": 1.0 },
    { "setId": "...", "weight": 75, "reps": 8, "estimate": 95, "weight": 0.5 }
  ],
  "method": "epley" | "brzycki" | "velocity-load-regression"
}
```

Lets the coach explain _why_ the number, flag suspicious estimates (e.g., one set is way off from the others), and gives the user something to challenge or trust.

## 2026-05-04 — Tool consolidation: per-set summary + device.configure

**Use case:** During the 5-set lat pulldown progression, every set-end was the same 3–4 calls in sequence (`set.end` → `set.get` → `metrics.compute vbt.set` → `metrics.compute fatigue.set` → `metrics.compute quality.rep` if baseline). Every weight change was 3 sequential `device.set_*` calls. That's ~30 calls across the session that didn't add information density — they just round-tripped the conversation.

**Two consolidations:**

1. **`set.summary(setId, { baselineSetId?, pipelines?: ['vbt', 'fatigue', 'quality'] })`** — single tool returning:
   - Set metadata (weight, mode, started/ended timestamps)
   - Per-rep table with `{repNumber, peakConcentricVelocity, peakEccentricVelocity, startPos, endPos, romDelta, peakForce, concentricSampleCount, eccentricSampleCount}` — the table I rebuilt by hand every set-end
   - Aggregate pipeline outputs (filtered by `pipelines` arg, default all standard ones)
   - Rep-quality flags surfaced from the underlying pipelines (e.g., `firstRepHasSetupPause`, `phaseMisclassified`)

   Should remain composable: `pipelines` arg lets callers skip expensive ones. Defaults give the "I just ended a set, tell me everything" shape that ~100% of `set.end` calls actually want.

2. **`device.configure({ weight?, mode?, eccentric?, chains? })`** — atomic multi-parameter device update. Replaces the 3 sequential `device.set_*` calls every weight change. Transactional semantics (all-or-nothing) where the SDK supports it.

**What we explicitly do NOT want** (rejected during this session):

- A `workout.start_set({weight, mode, exerciseName, ...})` mega-tool. Tempting but encodes workflow logic in the MCP layer; violates the "thin transport" principle the audit confirmed. With `device.configure` + `set.start` available separately, the composition cost is two calls vs one — not enough to justify the workflow creep.

## 2026-05-04 — Observability: pipeline-level rep-quality flags + start/end position metrics

**Use case:** Three observability gaps surfaced repeatedly during the lat pulldown progression:

1. **Rep-1 setup-pause re-discovered every set.** I manually noticed "rep 1 has anomalously low concentric peak velocity" by inspecting per-rep data after every set-end. The `vbt.set` pipeline has all the information needed to flag this automatically — long phase=2 (HOLD) duration before phase=1 movement starts, peakVelocity calculated from a tiny prefix sample window, etc. Add a `flags` field to `vbt.set` output: `{firstRepHasSetupPause: bool, firstRepHoldDurationMs: number, phaseMisclassificationSuspected: bool}`. Cheap to compute, high-value for the coach.

2. **Start/end position is a first-class movement signal, not just ROM delta.** During this session we discovered that increasing load shifts the rep window — start position drops (more lat stretch at top), end position drops (less hip-pocket depth), but ROM delta stays similar. Today's `vbt.set` only exposes ROM delta. We need explicit `startPos: {first, last, mean}` and `endPos: {first, last, mean}` so the trade-off pattern is visible without dropping into `set.get`.

3. **Set-to-set comparison is the workout's primary question.** "How did this set differ from the last?" was the implicit query I rebuilt by hand on every weight increase. Propose `set.compare(setIdA, setIdB)` returning structured per-rep diffs: velocity ratio per rep, ROM shift (start/end/delta), force delta, fatigue trajectory comparison. Saves two `set.get`s + manual subtraction every time we change anything.

**Implementation note:** items 1 and 2 are workout-analytics changes (pipeline output schema). Item 3 is a voltras-mcp tool that composes existing `set.get` data; no analytics changes needed.

## 2026-05-04 — Position metrics are setup-relative, not movement-relative (upstream: workout-analytics)

**Use case:** Single-arm cable lat pulldown, 5 sets at 20–90 lbs. Tracking start/end positions per rep showed a clean trade-off pattern: as weight increased, start position dropped (more lat stretch at the top, ~200 units) AND end position dropped (less hip-pocket depth, ~286 units). Net ROM stayed stable.

**Limitation:** absolute position values are anchored to wherever the user knelt relative to the cable post. Knee 12" further back → every "start" and "end" is offset by 12" worth of cable, even with identical movement quality. So:

- Within-session, same-setup comparisons (like our 5-set progression today) are valid — the user's setup didn't change between sets.
- Cross-session comparisons would be misleading. "Your start position dropped 200 units this week" might just mean you knelt closer to the post.

**Three candidate fixes in workout-analytics:**

1. **Per-session calibration anchors.** Capture `maxRetracted` and `maxPulled` reference positions during a per-session calibration step at exercise start (user pulls to full ROM once before the working set). Normalize subsequent rep positions as `(pos - maxRetracted) / (maxPulled - maxRetracted)` → unit-less 0..1. Setup-invariant by construction.
2. **Velocity-vs-ROM-percentile.** Instead of "peak velocity = 690 at position 695," report "peak velocity = 690 at 50% of ROM." Phase shape becomes the primary signal, absolute position becomes secondary. Easier to do without explicit calibration if we use the rep's own min/max as the normalizer.
3. **Per-exercise anchor frames in the catalog.** When the exercise catalog ships, each exercise definition could specify expected anchors (e.g., "lat pulldown — start: arm extended, end: handle at clavicle"). The session captures these once and stores them as session metadata.

Option 2 is the cheapest and most immediately useful — every existing rep already has min/max position implicit in its samples. Option 1 is more accurate but adds a calibration step to the user flow. Option 3 is the long-term home but depends on catalog maturity.

## 2026-05-04 — Rep 1 setup-pause skews VBT/fatigue (upstream: workout-analytics)

**Use case:** Single-arm cable lat pulldown, 55 lbs, 8 reps. The aggregate `vbt.set` showed velocity climbing 87 → 333 across the set, suggesting "user got faster" or "warmup ramp-up." Rep-by-rep peak concentric velocity told a different story: rep 1 = 143, reps 2–8 stable at 583–690. Rep 1 was an outlier, not the start of a ramp.

**Root cause:** the user starts with the cable retracted. To begin a rep they reposition (slow phase=1 frames as the cable plays out from ~45 to ~251 — their actual start position), then briefly hold while bracing, then execute the real pull. The Voltra firmware labels the slow reposition as phase=1 (CONCENTRIC) and the held-then-pull burst as phase=2 (HOLD), so the actual fast concentric portion of rep 1 ends up under HOLD samples and never contributes to `peakVelocity` of the concentric phase. Result: rep 1's concentric peak is artificially low, dragging `first` velocity in `vbt.set` and inflating `lossPct` toward "negative loss" (= apparent ramp-up).

**Where to fix:** workout-analytics. Two candidate paths:

1. **Trim leading low-velocity prefix from rep 1's concentric phase.** Define an "engagement point" — e.g. first sample where velocity exceeds X% of the rep's peak, or where position has moved more than Y from the rep-start position. Recompute concentric metrics from that point forward.
2. **Reclassify mis-tagged HOLD-during-rep samples as CONCENTRIC.** If a sample sequence inside a single rep transitions phase=1 → phase=2 → phase=1 with continuous forward motion, treat the middle phase=2 as continuation of CONCENTRIC. This is a phase-classifier correction, not a metric-only fix.

Option 1 is safer (only affects analytics output, doesn't rewrite phase labels). Option 2 is more correct but riskier (other consumers may rely on the raw phase labels).

**Symptom this would also fix:** quality.rep / fatigue.set comparisons that key off `first` rep velocity will become reliable across this exercise pattern. Right now the "first rep is the baseline" assumption is shaky for any movement that requires the user to position themselves before pulling — single-arm pulldowns, lat pulldowns from a fixed starting position, pretty much any cable exercise where the cable needs to be played out before the working pull.

**Coaching workaround until fixed:** PT Claude should compute set-level metrics from reps 2..N (skip rep 1) and surface a note explaining why. Cheap to do at the MCP layer; cleaner if workout-analytics has a `vbt.set --skipFirstRep` flag.

## 2026-05-04 — Observability gap: PT Claude has no way to inspect captured data

**Use case:** During the rep-doubling diagnosis I had to drop into SQLite directly to see per-rep telemetry. There's no MCP tool today that returns a completed set's reps, the recent telemetry frames the bridge processed, or the bridge's recent event log. That's a foundational gap — PT Claude can't debug or coach effectively against a black-box pipeline.

**Wave 1 (shipping in this batch):**

- `server.health` — single tool returning build commit, adapter (`node`|`mock`), SDK + workout-analytics versions, db path, log level. Settles "is mock being used / is the running build current" in one call.
- `set.get(setId)` — full rep payload for a completed set. Replaces the SQLite-direct hack.
- `debug.recent_frames(n)` — last N raw `onFrame` samples buffered by the bridge (phase, position, velocity, force, timestamp). Diagnostic only, capped buffer.
- `debug.recent_events(n)` — last N bridge-level events (`onRepBoundary`, `onSetBoundary`, `onSettingsUpdate`, `onConnectionStateChange`) with timestamps. Surfaces what the bridge actually saw, not what we hoped it saw.

**Wave 2+ (deferred):** `session.get_with_reps`, `metrics.list_pipelines`, historical resources (`voltra://sets/recent`), `device.get_settings` (full).

## 2026-05-04 — Push-driven set lifecycle (MCP → PT Claude callbacks)

**Status:** Architecture complete on 2026-05-04. Validated end-to-end. Six channel events + trigger DSL shipped on `feat/observability-and-bridge-refactor`. `notifications/claude/channel` is the working push mechanism (NOT `notifications/resource_updated` — host-side cache only, never reaches the model). Launch flag: `claude --dangerously-load-development-channels server:voltras`. Full status table + UX quirks in HANDOFF.md. Remaining: reliability log, plugin-wrap for marketplace distribution, channel suppression API, and bilateral/dual-Voltras integration once that lands.

**Use case:** The current PT loop requires the user to type "done" between sets. That's friction during a workout — they're breathing, sweating, often not at the keyboard. PT Claude should be able to _register interest_ in specific telemetry-derived events when the set starts, then react when the MCP fires them.

**Sketch:**

```jsonc
// at set.start, register triggers
{
  "name": "set.start",
  "arguments": {
    "watch": {
      "stopOn": [
        { "type": "rep_count_reached", "value": 8 },
        { "type": "velocity_loss_exceeded", "pct": 25 },
        { "type": "set_ended_by_device" }, // user pressed end on Voltra UI
        { "type": "idle_timeout_ms", "value": 30000 }, // no reps for 30s
      ],
      "notifyOn": [
        { "type": "rep_completed" }, // every rep, with vel/force/rom
        { "type": "rom_inconsistency", "deltaPct": 15 },
        { "type": "form_breakdown_heuristic" }, // TBD pipeline
      ],
    },
  },
}
```

PT Claude registers, the MCP watches the telemetry stream, and when a trigger fires the MCP pushes a notification (or resolves a long-running tool call) so the conversation can react without polling.

**Implementation path (chosen 2026-05-04):**

`notifications/claude/channel` (Claude Code experimental capability) is the delivery mechanism. Server declares `experimental: { 'claude/channel': {} }`; events go out via `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })` and arrive in the live conversation as `<channel source="..." ...>` tags. `notifications/resource_updated` was ruled out — Claude Code consumes those for client-side cache only, never delivers to the model.

Foundation already built (commit `1b238ae`, plus rep-index off-by-one fix follow-up): capability declaration, `McpChannelPublisher`, per-rep + set-lifecycle emissions, smoke-test tool. Launch with `claude --dangerously-load-development-channels server:voltras`.

What's left: the trigger DSL above (filter what gets pushed), the `timer.wait → timer.start({ onComplete })` upgrade, and (later) plugin-wrapping for marketplace distribution. The blocking `set.wait_for_event` fallback is no longer needed — channels carry the same UX without burning tool turns.

**Coaching scenarios this unlocks:**

- "Stop the set when velocity drops 25%" — let go of the cable, MCP catches it, PT Claude immediately calls the rest period.
- "Tell me on rep 6" — pre-warn the user when they're 2 reps from target so they can push.
- "Bilateral asymmetry trigger" (pairs with the multi-device wishlist below) — fire when left/right ROM diverges by N%.
- "RPE auto-prompt" — set ends, PT Claude immediately asks "what was that out of 10?" without the user prompting first.

**Open design questions:**

- Is the trigger DSL declarative (the user/PT registers what they want) or fixed (server emits a known set, PT Claude filters)? Declarative is more flexible but more surface area to test.
- Idempotency: if a velocity-loss trigger fires mid-set, does it auto-stop the set or just notify? Probably notify — let PT Claude make the call.
- Backpressure: what if PT Claude is mid-thinking when an event fires? MCP push is fire-and-forget at the protocol level; we'd want client-side buffering.

## 2026-05-04 — Rep aggregation splits each rep into two records

**Use case:** Did 8 working reps of a single-arm cable lat pulldown. The Voltra device UI confirmed "1 set 8 reps". `set.end` reported 15 reps stored. Pulled the SQLite rows directly:

```
rep | conc.peakV | ecc.peakV
  0 |     37     |     0
  1 |      0     |    79
  2 |    119     |     0
  3 |      0     |    28
  4 |      0     |     0     ← noise
  5 |      0     |     0     ← noise
  6 |      5     |     0
  7 |      0     |    16
  ...
```

Each real rep is stored as two rows — one concentric-only, one eccentric-only — plus a couple of zero-zero noise rows. ~2× rep inflation makes every metric pipeline (`vbt.set`, `fatigue.set`, `quality.rep`) read split-phase rows as if they were whole reps. Velocity loss, fatigue, ROM consistency — all currently meaningless on real device data.

**Root cause:** `voltras-mcp/src/state/event-bridge.ts:109-127` calls `live.appendRep()` at every `onRepBoundary` event. The device's `rep_boundary` BLE notification fires at _every phase transition_ (concentric→eccentric, eccentric→idle), not at full-rep completion. The bridge naively assembles whatever's in the sample buffer at each boundary into a "rep".

**Secondary bug:** the rep `repNumber` field jumps then resets (`1, 2, 1, 1, 1, ...`). The SDK fired an `onSetBoundary` mid-set (likely triggered by our `Workout.GO` engagement command in `set.start`), and the bridge's `onSetBoundary` handler at `event-bridge.ts:133` resets `nextRepNumber = 1`. So our rep numbering is unreliable too.

**Fix paths:**

- Buffer across phase transitions until a full cycle is observed (concentric → eccentric → idle/concentric-of-next-rep). Emit one rep at the _start_ of a new cycle, not at every boundary.
- Or: ignore `onRepBoundary` entirely. Use `onFrame` to detect cycle completion via `frame.phase` transitions ourselves. SDK boundary events become "noise"; we own the cycle detector.
- Or upstream: investigate whether the SDK's `rep_boundary` decode should collapse phase-transitions into full-rep events. Probably the cleaner fix — every consumer otherwise has to reimplement this logic.
- Suppress the spurious `onSetBoundary` reset when our explicit `set.start` issued the engage command. Track expected vs unexpected set boundaries.

**Until fixed**, telemetry-driven coaching is unreliable on real device data. Mock adapter likely emits cleaner events (test fixture) — would explain why integration tests didn't catch this.

## 2026-05-04 — Exercise catalog is empty

**Use case:** Tried to pull a "single-arm cable lat pulldown" from the catalog mid-session — `exercise.search` returned `[]` for `lat`, `pull`, `lat pulldown`. Catalog file at `workout-analytics/src/exercises/data/catalog.json` is literally `[]`. The schema is rich (cableSetup, instructions, formCues, commonMistakes, tips) but no entries exist. Comment in `catalog.ts` points at `npm run exercises:pipeline` as the intended populator.

**What we want:** Real catalog entries that PT Claude can load, including Voltra-specific cable setup notes (mount height, attachment, eccentric default) so the trainer can talk through setup without the user having to know the recipe each time.

**First entry to author** — Single-Arm Cable Lat Pulldown (cross-body / Jeff Nippard style). Use this as the seed for the first hand-authored entry next time we touch workout-analytics:

```jsonc
{
  "id": "single-arm-cable-lat-pulldown-crossbody",
  "name": "Single-Arm Cable Lat Pulldown (Cross-Body)",
  "aliases": [
    "jeff nippard lat pulldown",
    "kneeling single-arm pulldown",
    "cross-body lat pulldown",
  ],
  "muscleGroups": ["lats"],
  "secondaryMuscleGroups": ["biceps", "traps"],
  "movementPattern": "pull",
  "exerciseType": "isolation",
  "equipment": [{ "name": "Cable + D-handle", "category": "cable" }],
  "cableEquivalent": true,
  "cableSetup": {
    "cablePath": "high",
    "attachments": ["d-handle", "single-handle"],
    "notes": "Highest mount on the rack. Default eccentric 0%; +10–20% to emphasize stretch overload.",
  },
  "description": "Single-arm lat pulldown done across the body to maximize lat stretch at the top.",
  "instructions": [
    "Kneel facing the cable, working-side knee down, opposite knee up (or seated on a bench).",
    "Angle torso ~30° away from the working side (right arm → torso turns left).",
    "Hips square, ribcage tall, slight forward lean from the hips.",
    "Top: arm fully extended overhead and across the midline; let the scap upwardly rotate — feel the deep lat stretch.",
    "Pull: lead with the elbow, drive it down and back toward the hip pocket.",
    "Bottom: handle finishes near the hip / lower ribs, scap depressed, no shoulder shrug.",
    "Eccentric: controlled return to full stretch — don't let the weight yank you up.",
  ],
  "formCues": [
    "Elbow to hip, not hand to chest.",
    "Stretched position is the money rep — don't shortcut the top.",
    "No shoulder shrug at the bottom; keep the scap depressed.",
    "Ribcage tall; resist the urge to round and crunch in.",
  ],
  "commonMistakes": [
    "Pulling with the bicep instead of leading with the elbow.",
    "Standing/kneeling square to the cable — kills the cross-body stretch.",
    "Ripping out of the stretch with momentum at the top of each rep.",
  ],
  "tips": [
    "Pair with a contralateral oblique cue ('don't side-bend toward the cable') to keep the lat doing the work.",
    "If grip is the limiter before the lat, switch to a wrist strap on the D-handle.",
  ],
  "qualityScore": 80,
}
```

Open questions before merging:

- Hand-authored entries vs `exercises:pipeline` output — same file, separate file, or convention? Pipeline may overwrite hand edits.
- Voltra-specific fields (mount position, eccentric default) currently squat in `cableSetup.notes` — eventually warrants a typed sub-shape.

## 2026-05-04 — Multi-device support in a single MCP

**Use case:** Chest flies. Each arm pulls an independent Voltra; the lift only works with two devices controlled in lockstep. Other bilateral movements (cable rows, single-arm-asymmetry work, partner training) hit the same wall.

**Current state:** `ServerState` holds a single `manager`/`client` (`src/state/server-state.ts:44-51`). Every device/set/session tool operates on those singletons with no slot/device routing param. Workaround today is two MCP server instances with namespaced tools — clunky, doesn't let one set of coaching cues see both sides at once.

**Sketch of what'd need to change:**

- `ServerState` → `Map<slotId, { manager, client, live }>` (or `slots: { left, right }` if we cap at 2). SQLite store can stay shared if rows carry a `slot` column.
- Every device/set/session tool gains an optional `slot` argument. Default to "the only connected slot" when unambiguous so single-device flows don't get noisier.
- `set.start` / `set.end` / `set.live_metrics` need to either fan out across slots or accept a slot list. For chest flies we want one logical "set" with two streams of telemetry, not two independent sets.
- `metrics.compute` needs a way to express bilateral asymmetry (per-side velocity loss, ROM mismatch, force imbalance) — new pipeline, not just slot-routing.
- Event bridge (`src/state/event-bridge.ts`) currently subscribes one client; would need per-slot subscriptions with slot-tagged events.

**Open questions:**

- One logical set across both arms, or two parallel sets that share a session? Affects schema and the coaching surface.
- How does the existing `quality.rep` baseline pipeline handle bilateral data? Probably needs a per-side baseline.
- Connection ergonomics — `device.scan` returns a flat list; do we add a `slot` arg to `device.connect`, or auto-assign first-connected to "left"?
