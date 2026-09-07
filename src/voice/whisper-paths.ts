// Where the two whisper artifacts live inside the installed `nodejs-whisper`
// package, and whether they are actually on disk.
//
// `npm ci` restores the package but not the compiled CLI, so voice input can be
// dead while everything else reports healthy (VW-155). `server.health` reports
// this as `voiceReady` so the gap is visible from inside a session.
//
// The two relative paths are duplicated in scripts/lib/whisper-paths.mjs — the
// install-time rebuild runs before `dist/` exists, so it cannot import this
// module. __tests__/whisper-paths.test.ts asserts the copies agree.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Compiled whisper.cpp CLI that `nodejs-whisper` shells out to. */
export const WHISPER_CLI_RELATIVE = 'cpp/whisper.cpp/build/bin/whisper-cli';

/** GGML weights for `tiny.en` — the voice listener's DEFAULT_STT_MODEL. */
export const WHISPER_MODEL_RELATIVE = 'cpp/whisper.cpp/models/ggml-tiny.en.bin';

/** Presence of each artifact voice input needs before it can transcribe. */
export interface VoiceReady {
  whisperCli: boolean;
  model: boolean;
}

/** Absolute paths of both artifacts for an installed `nodejs-whisper` root. */
export function whisperArtifactPaths(packageRoot: string): { cli: string; model: string } {
  return {
    cli: join(packageRoot, WHISPER_CLI_RELATIVE),
    model: join(packageRoot, WHISPER_MODEL_RELATIVE),
  };
}

/**
 * Probe both artifacts. Returns all-false when `nodejs-whisper` itself cannot
 * be resolved, which is the same operational outcome: no transcription.
 */
export function readVoiceReady(exists: (path: string) => boolean = existsSync): VoiceReady {
  let packageRoot: string;
  try {
    packageRoot = dirname(createRequire(import.meta.url).resolve('nodejs-whisper/package.json'));
  } catch {
    return { whisperCli: false, model: false };
  }
  const paths = whisperArtifactPaths(packageRoot);
  return { whisperCli: exists(paths.cli), model: exists(paths.model) };
}
