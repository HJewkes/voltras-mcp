// Input schemas for `system.listen_*` voice tools.
//
// The listener runs an in-process Silero VAD (onnxruntime-node) + `nodejs-whisper`
// STT — no Python, no wake-word model. "Wake detection" is text-matching on the
// transcript, so the wake phrase (default `hey coach`) is just a string list.
// Both tools are idempotent — repeating `listen_start` returns the current
// status without re-arming; `listen_stop` on a stopped listener succeeds quietly.

import { z } from 'zod';

const STT_MODELS = ['tiny.en', 'base.en', 'small.en'] as const;

/**
 * Input for `system.listen_start`.
 *
 * `wakePhrases` are matched (case-insensitively) against the whisper transcript
 * to open a conversational turn; safety phrases (stop/unload/…) are always-on
 * and need no wake phrase. `sttModel` picks the whisper.cpp model nodejs-whisper
 * auto-downloads; `tiny.en` is the default for the safety path's latency budget.
 * `maxUtteranceSec` caps a single utterance before it is force-sent to STT.
 */
export const SystemListenStartInput = z
  .object({
    wakePhrases: z.array(z.string().min(1).max(64)).min(1).max(8).optional(),
    sttModel: z.enum(STT_MODELS).optional(),
    maxUtteranceSec: z.number().int().min(2).max(30).optional(),
  })
  .strict();

export type SystemListenStartInputType = z.infer<typeof SystemListenStartInput>;

/** Input for `system.listen_stop`. No fields — gracefully tears down the listener. */
export const SystemListenStopInput = z.object({}).strict();
export type SystemListenStopInputType = z.infer<typeof SystemListenStopInput>;
