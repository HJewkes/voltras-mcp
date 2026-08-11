# VMCP-02.86 — voice safety stop resolves its slot from live state

Critical safety bug found on hardware 2026-08-11 with the operator standing at a
loaded cable machine. This note records what was wrong, what changed, the
bilateral design call, and what still needs bench verification.

## The defect

`src/tools/voice-tools.ts` held `const SAFETY_SLOT = 'primary'`. The Tier-A
fast-path called `safety.evaluate('primary')` and `safety.unload('primary')`, so
the deterministic voice stop could only ever target the `primary` slot.

With a device bound to `left`/`right` — which every bilateral rig does, and which
`device.connect slot:'auto'` does for anyone with a persisted binding — there is
no `primary` slot at all. `getSlot` threw, `evaluateSafely` swallowed it as "not
warranted", and the fast-path fell through to `publishVoiceInput`. The operator
saw a plain `voice_input` carrying the transcript "Stop.", indistinguishable from
ordinary speech. No error, no warning, no log line. **The cable stayed loaded.**

Reproduced twice on VTR-212006 bound to slot `right` (169 ms / 162 ms latency,
active set present both times). Phase 3b passed 8/8 on 2026-08-01 only because
that session used the default `primary` slot.

## The fix

1. **Slot resolution from live state.** `VoiceSafetyContext` gains
   `connectedSlots(): string[]`. The fast-path surveys every connected slot with
   the existing `isSafetyUnloadWarranted` predicate instead of naming one.
   The predicate itself is untouched — this is purely a resolution change.
2. **`makeVoiceSafety` extracted** from `src/client-connection.ts` into
   `src/tools/voice-safety.ts`. It was a private closure, which is why no test
   could reach the state↔fast-path seam where the bug lived.
3. **Bilateral sweep.** When any connected slot is warranted, every connected
   slot is unloaded (see below).
4. **No more silent downgrade.** A matched safety phrase that cuts nothing now
   publishes `deterministic_stop_unavailable` (`unloaded: 'false'`, a `reason`
   of `no_safety_context` / `no_connected_slot` / `evaluate_failed` /
   `not_warranted`, and the per-slot verdicts) alongside the conversational
   `voice_input`. The conversational forward is kept deliberately — "stop" with
   nothing loaded is a legitimate thing to say to a coach — but it is no longer
   the *only* thing on the wire.
5. **Per-slot reporting.** One `deterministic_stop_triggered` per unloaded slot,
   each with its own `slot` meta key (matching the push-event convention), plus a
   `trigger` of `warranted` or `bilateral_sweep`. A per-slot unload failure
   publishes `SAFETY_UNLOAD_FAILED` carrying `slot`, and one side failing no
   longer aborts the other.

## The bilateral decision: "stop" cuts BOTH cables

**Decided: sweep both.** The predicate decides *whether* the stop fires; once it
fires, every connected slot is cut.

Reasoning:

- A lifter mid-bilateral-press who shouts "stop" wants out of the whole lift.
  Releasing one side while the other stays loaded turns a symmetric load into an
  asymmetric one under a body that is already failing — a worse position than
  either "both loaded" or "both slack".
- The warranted-only alternative is unreliable in exactly the case that matters.
  `deriveLoadState` reads `unloaded` during ordinary weight-training reps, so the
  operative gate is the active-set check — and on a bilateral rig set boundaries
  across the two slots can skew (reconciler timing, a side that finalized a beat
  earlier). Warranted-only would then leave a genuinely loaded cable up.
- The counter-risk — cutting a cable nobody is holding — is small here.
  `MAX_SLOTS` is 2, stdio is single-client, so both slots are the same athlete's
  rig by construction. `unloadSlot` is idempotent, and the existing predicate doc
  already states the bias: "better an unnecessary unload than a missed one".
- This does **not** widen the trigger. With nothing warranted anywhere, nothing
  is unloaded at all.

If the workspace later supports two independent athletes on one process, this
call has to be revisited — the sweep assumes one rig, one operator.

## Verification

Gates (all green): `npm test` (2196 tests / 124 files), `npm run typecheck`,
`npm run lint`, `npm run build`.

**Mutation used:** in `surveySlots`, replaced `safety.connectedSlots()` with a
hardcoded `['primary']` — i.e. exactly the pre-fix behavior. Five tests failed,
the required regression among them:

- `device on 'right' only, mid-set → unloads right and publishes the stop`
  (`expected [] to deeply equal [ 'right' ]`)
- `bilateral: one warranted side cuts BOTH cables`
- `one side failing to unload still reports the side that was cut`
- `nothing warranted → loud deterministic_stop_unavailable, not a bare voice_input`
- `no device connected → unavailable with reason no_connected_slot`

Restoring the fix returns the file to 38/38 passing.

New/changed tests:

- `src/tools/__tests__/voice-tools.test.ts` — describe block
  `Tier-A safety fast-path — slot resolution (VMCP-02.86)`, driving the real
  mic → VAD → whisper → transcript-router → fast-path chain with a slot-aware
  safety context whose `evaluate` throws on unbound slots, like the real one.
- `src/tools/__tests__/voice-safety.test.ts` (new) — `makeVoiceSafety` over a
  fake `ServerState`: `connectedSlots` reports `right` when that is the only
  binding, skips a disconnected bootstrap `primary`, and `evaluate` / `unload`
  route to the slot they are handed.
- `src/state/__tests__/channel-payloads.test.ts` — the new
  `deterministic_stop_unavailable` builder and the `trigger` field.

## Still needs hardware verification (I could not run this — no device)

1. **The original repro, inverted.** VTR-212006 bound to slot `right`, session +
   set active, say "Stop." → the cable must go slack and a
   `deterministic_stop_triggered` with `slot: right` must arrive inline.
2. **Bilateral sweep on real hardware.** Both units bound (`left` + `right`),
   bilateral set active, one "stop" → both cables slack, two
   `deterministic_stop_triggered` events, one `warranted` and (if the sides are
   skewed) one `bilateral_sweep`. Watch for whether the two `unloadDevice` BLE
   writes in parallel are well-behaved on the adapter — they are issued
   concurrently via `Promise.all`, which the mock cannot exercise.
3. **Ack timing.** The spoken "Stopping. Weight off." now fires once after the
   first successful unload rather than after the single unload; confirm it still
   lands promptly and still ducks the mic.
4. **The unavailable event in practice.** Say a stop phrase with the device
   connected but idle (no set, no load) and confirm the
   `deterministic_stop_unavailable` event actually surfaces inline rather than
   only in `debug.recent_events`.
5. **Latency.** Previous bench runs saw 162–169 ms end-to-end. The survey now
   walks up to two slots before unloading; confirm the added work is noise.

Not touched, deliberately: the cue/deaf-window defect (VMCP-05.01) is separate —
it drops the utterance *before* routing, this bug dropped it *after*. Both must
be fixed for the voice stop to be trustworthy end to end.
