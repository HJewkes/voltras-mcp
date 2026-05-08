// Input schemas for `system.listen_*` voice tools.
//
// MVP scope: an off-by-default mic listener that transcribes user speech via
// the openWakeWord Python sidecar + nodejs-whisper. Both tools are idempotent
// — repeating `listen_start` returns the current status without re-spawning;
// `listen_stop` on an already-stopped listener succeeds quietly.
//
// Wake-word phrase is configurable so swapping a custom-trained `hey_coach`
// model into voice-models/ is a one-line change. The MVP ships with
// openWakeWord's built-in `hey_jarvis` as the default; see voice-models/README.md
// for the swap-in procedure.

import { z } from 'zod';

const STT_MODELS = ['tiny.en', 'base.en', 'small.en'] as const;

/**
 * Input for `system.listen_start`.
 *
 * `wakeWord` keys into openWakeWord's pre-trained set when no model file
 * lives in voice-models/. `wakeWordModelPath` overrides with a custom .onnx;
 * when both are supplied, the path wins and `wakeWord` becomes informational.
 *
 * `sttModel` controls which whisper.cpp model nodejs-whisper auto-downloads
 * on first transcription. `base.en` (~150 MB) is the recommended default —
 * sub-second p50 on Apple Silicon and handles workout vocab reliably.
 */
export const SystemListenStartInput = z
  .object({
    wakeWord: z.string().min(1).max(64).optional(),
    wakeWordModelPath: z.string().min(1).max(512).optional(),
    sttModel: z.enum(STT_MODELS).optional(),
    maxUtteranceSec: z.number().int().min(2).max(30).optional(),
  })
  .strict();

export type SystemListenStartInputType = z.infer<typeof SystemListenStartInput>;

/** Input for `system.listen_stop`. No fields — gracefully tears down the listener. */
export const SystemListenStopInput = z.object({}).strict();
export type SystemListenStopInputType = z.infer<typeof SystemListenStopInput>;
