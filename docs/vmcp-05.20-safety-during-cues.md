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

### Mutes are paired by handle (VW-176)

Two mutes overlap routinely: `cue-emitter` calls `speak()` without `interrupt`
for non-urgent cues, so a cue plays over a model `system.speak` that is already
running. `mute(spokenText)` therefore returns an opaque `MuteHandle`, the
listener keeps one entry per outstanding handle, and `unmute(handle)` removes
exactly that entry. Releasing a second time with the same handle is a no-op, so
the failsafe timer in `speak()` racing the child's `exit` cannot free another
speaker's entry, and the depth cannot go negative. `isMuted` is still "any
outstanding mute".

The first implementation released FIFO. When the shorter utterance ended first
it dropped the LONGER, still-playing text, so the echo filter compared the tail
of that text against words nobody was saying: the echo was missed and the safety
tier could fire on our own voice. `markMutedCapture` copies the text of every
currently active entry into the utterance's origin, which is only correct if the
entries are correct.

The queue cap follows the same principle: at cap 5 the listener now evicts the
oldest **muted-origin** utterance before any unmuted one, because the muted one
is most likely our own echo and the unmuted one may be the lifter.

### The safety tier is not lease-fenced (VMCP-01.65)

`system.listen_start` now builds a lease fence and hands it to
`createWeightFastPath`, so a spoken weight change is checked against the
single-writer lease. The safety path takes no fence: `onSafetyPhrase` goes
straight to `runSafetyFastPath` → `unloadSlot`. That is on purpose — a lifter
saying "stop" must cut the cable whether or not this session holds the write
lease. Do not add a fence there to make the two paths symmetrical.

## Why the wake and command tiers stay ducked

They are conveniences with a second chance — the lifter can repeat "hey coach"
or "set it to 70" a second later once the cue ends, and nothing is at risk in
the meantime. A safety phrase has no second chance worth relying on. Opening the
wake and command tiers to barge-in would widen the self-trigger surface for no
safety gain, so it was not done.

## Residual risk, stated plainly

**A safety word inside the spoken text becomes unreachable while it plays.** If
the cue says "don't stop now" and the lifter shouts "stop" over it, the echo
filter drops the shout. The two are genuinely indistinguishable from the
transcript alone. We took that trade because a false unload from our own voice
is worse than a stop the lifter can repeat once the cue ends (median 4.16 s).

For **cue templates** that risk is bounded by keeping safety words out of the
text: **0 of the 29 slot-filled `CUE_CATALOG` templates contains one**, verified
on 2026-08-11, re-confirmed by feeding real `say` audio of the worst-case cue
back through real whisper (it routed as `ignore` even with the echo filter
switched off), and now enforced in CI — `cue-templates.test.ts`, "spoken text
contains no safety phrase", renders every template and runs the router's own
matcher over the result, plus every phrase in the `SAFETY_ACK_PHRASES` unload-ack
pool. VW-157 turned that ack from one phrase into four; all four start with
"Stopping", which the matcher's word boundaries do not read as "stop", and none
contributes a `SAFETY_PHRASES` word to the echo filter's spoken-word set, so a
shouted "stop" over the ack cannot be covered as echo. The pool has its own
guards in `voice-safety.test.ts` over `routeTranscript` (the runtime path,
including its word-count gate) and plausible mishearings; the assertion here uses
the gate-free matcher instead, so it holds however long a phrase gets.

**That bound does not cover `system.speak`.** Model prose is unbounded, the
model writes a fresh line every set, and "stop", "release" and "let go" are
ordinary coaching vocabulary — the same words as `SAFETY_PHRASES`. For model
speech the echo filter is the whole defence between our own voice and an unload,
and the filter is only as good as the `activeSpeech` bookkeeping behind it. That
is why VW-176 (above) was a safety bug and not a tidiness one. Do not weaken the
mute/unmute pairing without re-reading this paragraph.

Negation is **not** a second line of defence. `isNegated`
(`transcript-router.ts`) only inspects the token immediately before the keyword,
so "don't stop" is negated but "don't ever stop", or any transcript where
whisper drops the "don't", is not.

Two other paths remain unfixed and are not in scope here:

- The whisper queue still drops an utterance at cap 5, so a safety phrase could
  still be lost under backlog. Cue audio occupies queue slots that it previously
  did not; the eviction now prefers a muted-origin utterance (see above), which
  improves the odds but is not a guarantee.
- An utterance already in flight when a cue starts is still flushed, so the
  window still extends slightly backwards in time.

## Measured

Desk measurement, no hardware and no mic: macOS `say` output fed into the
listener as PCM, real Silero VAD, real whisper `tiny.en`.

| Path                                                 | n   | latency (utterance close → routed) | routed as       |
| ---------------------------------------------------- | --- | ---------------------------------- | --------------- |
| "Stop." unmuted (control)                            | 3   | 171, 179, 197 ms                   | safety, 3/3     |
| "Stop." during a cue                                 | 3   | 161, 162, 179 ms                   | safety, 3/3     |
| Cue audio fed back, in-cue                           | 2   | —                                  | dropped as echo |
| Cue audio fed back, unmuted                          | 1   | —                                  | `ignore`        |
| Cue over a longer model line, echo of the longer one | 0   | not measured                       | —               |

The in-cue path is indistinguishable from the unmuted control, and both sit on
top of the 162-169 ms the bench measured on hardware. This is **latency after
the utterance closes**; the segmenter's 400 ms hangover plus the length of the
word itself come before it.

The overlap row is **unmeasured**: every measurement above used a single cue with
nothing else playing. The VW-176 path is covered by unit tests only
(`voice-listener.test.ts`, "overlapping speech (handle pairing)"), where `say` is
mocked. No desk `say` feed of two overlapping utterances has been run. Anyone
with the desk rig up should fill this row in — start a long `system.speak`, fire
a short cue over it, and feed back the tail of the long one.

## Still needs hardware verification before this ships

Bench step, from `sources/runbooks/BENCH-2026-09-next-sitting.md` Block B3:
rig bound, session + set active, `VMCP_CUES=on` and `VMCP_CUES_MIDSET=on` via
`system.set_cues`, listener armed (`tiny.en`, `micReady: true`), velocity-loss
watch at 15%. Grind a rep until the `slowdown` cue fires, and say "stop" **once,
while the cue is still speaking**. Pass = the cable goes slack and a
`deterministic_stop_triggered` arrives; the previous two runs of this exact
trial produced no events at all. Run the established controls on the same rig
first ("stop" unmuted → triggered; "stop" while idle → `unavailable` +
`voice_input`), so a failure can be told apart from a dead rig.

Also unrun and worth pinning while the rig is up: the intermediate recovery
offsets (mid-cue / 0 s / +0.5 s) that the same runbook carries alongside B3. Only
the +1.5 s row exists today, so the deaf window's end is bounded, not measured.
