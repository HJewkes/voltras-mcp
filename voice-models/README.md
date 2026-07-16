# Voice models

## `silero_vad.onnx`

The voice listener's speech gate (VMCP-02.77). [Silero VAD](https://github.com/snakers4/silero-vad)
v4 (LSTM h/c state), MIT-licensed, run in-process via `onnxruntime-node` — see
`src/voice/vad.ts`. It emits a per-frame speech probability that the
`SpeechSegmenter` turns into utterances; each utterance is transcribed by
`nodejs-whisper` (`tiny.en` by default) and routed on the transcript text
(`src/voice/transcript-router.ts`).

There is **no wake-word model** — "wake detection" is text-matching the wake
phrase (default `hey coach`) in the whisper transcript, and the always-on safety
phrases (stop / unload / …) are matched the same way. Nothing to train or
download; the VAD model is the only asset here and it ships in the repo.

### Contract (introspected from the model)

- inputs: `input` float32 `[1,512]`, `sr` int64 scalar (16000), `h`/`c` float32 `[2,1,64]`
- outputs: `output` float32 `[1,1]` (speech prob), `hn`/`cn` float32 `[2,1,64]`

Verify with the parity harness: `node scripts/vad-parity.mjs` (a speech WAV
yields many high-probability frames; silence yields ~0).
