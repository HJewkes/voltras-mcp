// Where the whisper artifacts live inside the installed `nodejs-whisper`
// package, and whether they are actually on disk.
//
// Transcription (`transcribeDetailed`, nodejs-whisper 0.4) runs the package's
// native addon plus a model file; the whisper-cli binary is not on that path
// (VW-962). So `voiceReady.addon` and `.model` are what decide whether speech
// transcribes. `whisperCli` is deprecated: it mirrors `addon` and no longer
// probes the binary.
//
// The addon is located by the package's own `findNativeAddon`, so its candidate
// list cannot drift. The CLI and model paths are duplicated in
// scripts/lib/whisper-paths.mjs (the install-time rebuild runs before `dist/`
// exists, so it cannot import this module), as is the addon candidate list for
// preflight. __tests__/whisper-paths.test.ts asserts the copies agree.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

type FindNativeAddon = (withCuda?: boolean) => string | undefined;

/** Compiled whisper.cpp CLI that `nodejs-whisper` shells out to. */
export const WHISPER_CLI_RELATIVE = 'cpp/whisper.cpp/build/bin/whisper-cli';

/** GGML weights for `tiny.en` — the voice listener's DEFAULT_STT_MODEL. */
export const WHISPER_MODEL_RELATIVE = 'cpp/whisper.cpp/models/ggml-tiny.en.bin';

/** Readiness of each artifact voice input needs before it can transcribe. */
export interface VoiceReady {
  /** The native addon `transcribeDetailed` loads is on disk. */
  addon: boolean;
  /**
   * @deprecated Mirrors `addon`; it no longer probes the CLI binary. Read `addon`.
   */
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
 * The package's own addon finder. Requiring `dist/native.js` does not load the
 * binary: it only imports fs, path, worker_threads and sibling helpers, and the
 * addon is loaded later by the worker thread.
 */
function packageAddonFinder(require: NodeRequire): FindNativeAddon {
  const native = require('nodejs-whisper/dist/native.js') as { findNativeAddon: FindNativeAddon };
  return native.findNativeAddon;
}

/**
 * Probe the addon and the model. Returns all-false when `nodejs-whisper`
 * itself cannot be resolved, which is the same operational outcome: no
 * transcription from the addon backend.
 */
export function readVoiceReady(
  exists: (path: string) => boolean = existsSync,
  findAddon?: FindNativeAddon,
): VoiceReady {
  const require = createRequire(import.meta.url);
  try {
    const packageRoot = dirname(require.resolve('nodejs-whisper/package.json'));
    const find = findAddon ?? packageAddonFinder(require);
    const addon = find(false) !== undefined;
    return { addon, whisperCli: addon, model: exists(whisperArtifactPaths(packageRoot).model) };
  } catch {
    return { addon: false, whisperCli: false, model: false };
  }
}
