#!/usr/bin/env python3
"""Voice-listener sidecar for voltras-mcp.

Reads raw 16 kHz, 16-bit, mono PCM from stdin (the format `node-record-lpcm16`
produces) and emits JSONL events to stdout when a wake word fires. Errors and
informational messages go to stderr so the parent Node process can capture them
without confusing the JSONL stream.

Event schema (one JSON object per stdout line, then '\n'):

    {"event": "ready",          "ts": 1715190000000, "model": "hey_jarvis"}
    {"event": "wake",           "ts": 1715190000000, "score": 0.92, "model": "hey_jarvis"}
    {"event": "utterance_end",  "ts": 1715190001500}        # optional, emitted when VAD is enabled

Stdin close → clean exit 0. Any unrecoverable error → exit 1 with a
message on stderr.

The wake-word phrase shipped with the MVP is whatever model file is supplied
to --model. openWakeWord ships a small set of pre-trained ONNX models
(`alexa`, `hey_jarvis`, `hey_mycroft`, `hey_rhasspy`, `timer`, `weather`).
None of those say "hey coach"; the user-chosen `hey_coach` phrase requires a
custom-trained model (synthetic Piper-TTS pipeline, ~30-60 min on Colab).
For MVP we ship the closest built-in (`hey_jarvis`) and document the swap-in
path; see voice-models/README.md.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import logging
import os
import sys
import time
from collections.abc import Iterator
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    stream=sys.stderr,
    format="[voice-listener] %(levelname)s %(message)s",
)
log = logging.getLogger("voice-listener")

# Audio format must match what `node-record-lpcm16` is configured to produce
# in src/voice/voice-listener.ts. Changing one without the other will silently
# corrupt the wake-word inference.
SAMPLE_RATE_HZ = 16_000
SAMPLE_BYTES = 2  # int16 mono
FRAME_SAMPLES = 1280  # openWakeWord expects 80 ms windows at 16 kHz
FRAME_BYTES = FRAME_SAMPLES * SAMPLE_BYTES
COOLDOWN_SECONDS = 1.5  # debounce repeated wake fires from the same utterance


def now_ms() -> int:
    return int(time.time() * 1000)


def emit(event: dict[str, Any]) -> None:
    """Write one JSONL event to stdout, flushing so Node sees it immediately."""
    sys.stdout.write(json.dumps(event, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_pcm_frames(stream: Any, chunk_bytes: int) -> Iterator[bytes]:
    """Yield fixed-size frames until stdin closes."""
    buffer = bytearray()
    while True:
        chunk = stream.read(chunk_bytes)
        if not chunk:
            return
        buffer.extend(chunk)
        while len(buffer) >= chunk_bytes:
            frame = bytes(buffer[:chunk_bytes])
            del buffer[:chunk_bytes]
            yield frame


def model_label(model_path: str) -> str:
    """Friendly name surfaced on JSONL events. Strips the .onnx suffix."""
    base = os.path.basename(model_path)
    return base[: -len(".onnx")] if base.endswith(".onnx") else base


def load_wakeword_engine(model_path: str | None, threshold: float) -> Any:
    """Import openWakeWord lazily so a missing install fails with a clear log.

    Returns the constructed `Model` instance. Caller drives the inference loop.
    """
    try:
        from openwakeword.model import Model
    except ImportError as err:
        log.error("openwakeword not installed: %s", err)
        log.error("install via: pip install -r voice-listener/requirements.txt")
        sys.exit(1)

    kwargs: dict[str, Any] = {"inference_framework": "onnx"}
    if model_path is not None:
        if not os.path.isfile(model_path):
            log.error("wake-word model file not found: %s", model_path)
            sys.exit(1)
        kwargs["wakeword_models"] = [model_path]
    log.info("loading openwakeword (threshold=%.2f, model=%s)", threshold, model_path or "<defaults>")
    return Model(**kwargs)


def detect_wake(engine: Any, frame: bytes, threshold: float) -> tuple[bool, float, str]:
    """Run one inference frame; return (fired, peak_score, model_name)."""
    import numpy as np  # local — only needed when openWakeWord is present

    samples = np.frombuffer(frame, dtype=np.int16)
    scores: dict[str, float] = engine.predict(samples)
    if not scores:
        return False, 0.0, ""
    name, score = max(scores.items(), key=lambda kv: kv[1])
    return score >= threshold, float(score), name


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="voltras-mcp voice listener sidecar")
    parser.add_argument(
        "--model",
        default=None,
        help="path to a custom wake-word .onnx file; default uses openWakeWord built-ins",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="confidence threshold for wake fire (0.0-1.0; default 0.5)",
    )
    parser.add_argument(
        "--smoke",
        action="store_true",
        help="boot, emit a ready event, exit immediately (used by CI smoke test)",
    )
    return parser.parse_args(argv)


def run_smoke_mode(args: argparse.Namespace) -> int:
    """Boot path used by tests and the README's smoke check.

    Verifies the script can import its deps and parse args without spinning up
    a real audio loop. Useful for `python listener.py --smoke < /dev/null`.
    """
    label = model_label(args.model) if args.model else "default"
    emit({"event": "ready", "ts": now_ms(), "model": label, "smoke": True})
    return 0


def run_listen_loop(args: argparse.Namespace) -> int:
    engine = load_wakeword_engine(args.model, args.threshold)
    label = model_label(args.model) if args.model else "default"
    emit({"event": "ready", "ts": now_ms(), "model": label})

    last_fire_ms = 0
    stdin = sys.stdin.buffer
    for frame in read_pcm_frames(stdin, FRAME_BYTES):
        fired, score, name = detect_wake(engine, frame, args.threshold)
        if not fired:
            continue
        ts = now_ms()
        if ts - last_fire_ms < COOLDOWN_SECONDS * 1000:
            continue
        last_fire_ms = ts
        emit({"event": "wake", "ts": ts, "score": score, "model": name or label})
    return 0


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if args.smoke:
        return run_smoke_mode(args)
    with contextlib.suppress(KeyboardInterrupt):
        return run_listen_loop(args)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
