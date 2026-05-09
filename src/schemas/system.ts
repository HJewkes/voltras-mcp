// Input schemas for `system.*` tools.
//
// `system.speak` is a macOS-only TTS surface — spawns the host's `say` binary
// so the model can deliver verbal cues during a workout instead of only
// emitting text the user has to read. The schema bounds text length and
// rate, rejects NUL bytes (cheap defense-in-depth even though the handler
// uses `spawn` rather than a shell), and gates voice/rate/interrupt/blocking
// behind optional fields so the simplest call is `{ text }`.

import { z } from 'zod';

const MAX_TEXT_CHARS = 500;
const RATE_MIN = 100;
const RATE_MAX = 500;
const NUL_CHAR = String.fromCharCode(0);

/**
 * Input for `system.speak`.
 *
 * `text` is bounded to 500 chars — enough for a coaching cue, well short of
 * any pathological dictation. We also reject NUL bytes outright; nothing
 * legitimate contains them, and rejecting up front keeps downstream layers
 * from having to think about C-string truncation.
 *
 * `voice` / `rate` pass through to `say -v <voice>` / `say -r <rate>` when
 * present. `interrupt` sends SIGTERM to any in-flight `say` child before
 * spawning the new one — useful for replacing a long-running cue with a more
 * urgent one. `blocking` makes the handler await `say` exit (verifies
 * playback finished before returning); the default fire-and-forget is the
 * right shape for most coaching prompts where the model wants to keep
 * talking while the device speaks.
 */
export const SystemSpeakInput = z
  .object({
    text: z
      .string()
      .min(1)
      .max(MAX_TEXT_CHARS)
      .refine((value) => !value.includes(NUL_CHAR), {
        message: 'text must not contain NUL (\\x00) characters',
      }),
    voice: z.string().min(1).max(64).optional(),
    rate: z.number().int().min(RATE_MIN).max(RATE_MAX).optional(),
    interrupt: z.boolean().optional().default(false),
    blocking: z.boolean().optional().default(false),
  })
  .strict();

export type SystemSpeakInputType = z.infer<typeof SystemSpeakInput>;
