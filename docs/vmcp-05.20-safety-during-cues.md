# VMCP-05.20 — hearing "stop" while a cue is playing

## The defect

Every TTS cue muted the voice listener, and `drainFrames` **discarded** muted mic
frames before VAD, the segmenter, and the router ever saw them. For the length of
each cue the mic was not merely ducked, it was deaf: nothing spoken during
playback reached the router at all, safety phrases included.

Two bench trials on 2026-08-11 caught it in the act. A lifter said "stop" once,
mid-cue, under load. No `deterministic_stop_triggered`, no
`deterministic_stop_unavailable`, no `voice_input` — zero events of any kind,
which is only possible if the frames were dropped. The cable stayed loaded and
two more reps were completed. Full record:
`sources/runbooks/RESULTS-2026-08-11-VMCP-05.01-deaf-window.md`, which measured
the mute window at a **4.16 s median** per cue (5.28 s worst case) and decided
EXEMPT.

## What changed

Ducking is now **safety-only routing**, not a discard.

1. `drainFrames` processes muted frames like any other — VAD, segmenter,
   whisper all run. Each utterance carries a `CaptureOrigin` recording whether
   any of its frames overlapped live TTS, and what TTS was saying at the time.
2. On an utterance captured during playback, `route` acts on the **safety tier
   only**. The wake phrase and the local weight fast-path are suppressed until
   the cue ends.
3. Before any of that, the transcript runs through `isSpeechEcho`
   (`src/voice/speech-echo.ts`). A transcript made ≥75% of the words being
   spoken aloud is the machine hearing itself and is dropped. `speak()` threads
   the cue text down through `mute(spokenText)` to make this possible.

The echo check outranks the safety tier deliberately: a stop hallucinated out of
our own cue audio would unload a loaded cable with nobody having asked for it.

## Why the wake and command tiers stay ducked

They are conveniences with a second chance — the lifter can repeat "hey coach"
or "set it to 70" a second later once the cue ends, and nothing is at risk in
the meantime. A safety phrase has no second chance worth relying on. Opening the
wake and command tiers to barge-in would widen the self-trigger surface for no
safety gain, so it was not done.

## Residual risk, stated plainly

**A safety word inside the cue text becomes unreachable for that cue.** If the
cue says "don't stop now" and the lifter shouts "stop" over it, the echo filter
drops the shout. The two are genuinely indistinguishable from the transcript
alone. We took that trade because a false unload from our own voice is worse
than a stop the lifter can repeat once the cue ends (median 4.16 s).

That risk is bounded by keeping safety words out of cue text: **0 of the 29
slot-filled `CUE_CATALOG` templates contains one**, verified on 2026-08-11 and
re-confirmed here by feeding real `say` audio of the worst-case cue back through
real whisper — it routed as `ignore` even with the echo filter switched off.

Two other paths remain unfixed and are not in scope here:

- The whisper queue drops the **oldest** utterance at cap 5, so a safety phrase
  could still be lost under backlog. Cue audio now occupies queue slots that it
  previously did not. Drop-oldest works in our favour in the common case (the
  cue starts before the shout), but it is not a guarantee.
- An utterance already in flight when a cue starts is still flushed, so the
  window still extends slightly backwards in time.

## Measured

Desk measurement, no hardware and no mic: macOS `say` output fed into the
listener as PCM, real Silero VAD, real whisper `tiny.en`.

| Path                          | n   | latency (utterance close → routed) | routed as       |
| ----------------------------- | --- | ---------------------------------- | --------------- |
| "Stop." unmuted (control)     | 3   | 171, 179, 197 ms                   | safety, 3/3     |
| "Stop." during a cue          | 3   | 161, 162, 179 ms                   | safety, 3/3     |
| Cue audio fed back, in-cue    | 2   | —                                  | dropped as echo |
| Cue audio fed back, unmuted   | 1   | —                                  | `ignore`        |

The in-cue path is indistinguishable from the unmuted control, and both sit on
top of the 162-169 ms the bench measured on hardware. This is **latency after
the utterance closes**; the segmenter's 400 ms hangover plus the length of the
word itself come before it.

## Still needs hardware verification before this ships

Bench step, from `BENCH-2026-07-26-consolidated.md` Phase 3c section C:
rig bound, session + set active, `VMCP_CUES=on` and `VMCP_CUES_MIDSET=on` via
`system.set_cues`, listener armed (`tiny.en`, `micReady: true`), velocity-loss
watch at 15%. Grind a rep until the `slowdown` cue fires, and say "stop" **once,
while the cue is still speaking**. Pass = the cable goes slack and a
`deterministic_stop_triggered` arrives; the previous two runs of this exact
trial produced no events at all. Run the established controls on the same rig
first ("stop" unmuted → triggered; "stop" while idle → `unavailable` +
`voice_input`), so a failure can be told apart from a dead rig.

Also unrun and worth pinning while the rig is up: section B's intermediate
recovery offsets (mid-cue / 0 s / +0.5 s). Only the +1.5 s row exists today, so
the deaf window's end is bounded, not measured.
