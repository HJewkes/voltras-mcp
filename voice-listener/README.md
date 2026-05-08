# voltras-mcp voice-listener sidecar

Python sidecar that runs [openWakeWord](https://github.com/dscripka/openWakeWord)
inference against a stream of 16 kHz mono PCM piped in from the parent
voltras-mcp Node process. Emits JSONL events on stdout when a wake word fires.

The MCP server (`src/voice/voice-listener.ts`) spawns this script when
`system.listen_start` is called and tears it down on `system.listen_stop`. You
should not need to invoke it manually outside of the smoke test below.

## Prerequisites

- **Python ≥ 3.10**. macOS Homebrew Python is fine; pyenv/conda also works.
- **A working virtualenv** is strongly recommended — installing into the system
  Python tends to collide with brew updates.

## Install

```bash
cd voltras-mcp/voice-listener
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

The MCP server's `system.listen_start` tool takes an optional `pythonBin`
parameter (defaults to `python3` on PATH); point it at the venv's interpreter
to avoid PATH ambiguity:

```bash
# In the launching shell:
export VOLTRAS_VOICE_PYTHON=$PWD/.venv/bin/python3
```

## Wake-word model

For the MVP we ship the integration wired against openWakeWord's pre-trained
**`hey_jarvis`** model (the closest 2-word built-in to the user's preferred
"hey coach" phrase). The model is auto-downloaded by openWakeWord on first
boot of the sidecar — no model file needs to live in `voltras-mcp/voice-models/`
to get the listener running for the first time.

The custom-trained `hey_coach` model is a follow-up: see
[`../voice-models/README.md`](../voice-models/README.md) for the openWakeWord
synthetic-data training pipeline (~30–60 min on a free Colab GPU).

## Smoke test

Verify the sidecar can boot end-to-end without an audio source:

```bash
# From inside the venv
python listener.py --smoke < /dev/null
# Expected: one JSON line on stdout, exit 0
# {"event":"ready","ts":...,"model":"default","smoke":true}
```

## Manual end-to-end test (optional, requires a mic)

```bash
# Terminal 1 — pipe sox-recorded mic audio into the sidecar
sox -d -t raw -c 1 -r 16000 -b 16 -e signed-integer - 2>/dev/null \
  | python listener.py
# Speak the wake word; expect a "wake" JSON event on stdout within ~100 ms
```

## Protocol contract (Node side reads this)

- Stdin: raw little-endian 16-bit PCM, 16 kHz, mono. Chunk size doesn't matter;
  the sidecar reframes to 80 ms windows internally.
- Stdout: one JSON object per line, fields per `listener.py`'s docstring.
- Stderr: human-readable logs only — the parent must NOT parse stderr as JSON.
- Stdin EOF: clean exit 0.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `openwakeword not installed` on stderr | Sidecar can't import openWakeWord | Activate the venv; rerun `pip install -r requirements.txt` |
| `wake-word model file not found` | Bad path passed via `--model` | Either drop the `.onnx` into `voice-models/` and pass the absolute path, or omit `--model` to use openWakeWord's auto-downloaded built-ins |
| No `wake` events fire even when speaking the phrase | Wrong model loaded; sample-rate mismatch | Check the `ready` event's `model` field on stdout matches your expected wake word; verify the parent recorder is producing 16 kHz mono int16 PCM |
| Sidecar exits immediately on macOS first run | TCC mic permission denied to the parent process | Grant Microphone access to the Node host (System Settings → Privacy → Microphone) |
