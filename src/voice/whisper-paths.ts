// Where the whisper artifacts live inside the installed `nodejs-whisper`
// package, and whether they are actually on disk.
//
// Transcription (`transcribeDetailed`, nodejs-whisper 0.4) runs the package's
// native addon plus a model file; the whisper-cli binary is not on that path
// (VW-962). So `voiceReady.addon` and `.model` are what decide whether speech
// transcribes. `whisperCli` is kept for existing readers as an alias of
// `addon`: it no longer probes the binary.
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

/** Relative location of the locally built native addon, per variant. */
export const WHISPER_ADDON_BUILT_RELATIVE = 'build/default/Release/nodejs_whisper.node';

/** Readiness of each artifact voice input needs before it can transcribe. */
export interface VoiceReady {
  /** The native addon `transcribeDetailed` loads is on disk. */
  addon: boolean;
  /** Alias of `addon`, kept so existing readers of the old field keep working. */
  whisperCli: boolean;
  model: boolean;
}

/** Candidate addon files for an installed package root, local build first. */
export function whisperAddonCandidates(packageRoot: string, platform: string): string[] {
  return [
    join(packageRoot, WHISPER_ADDON_BUILT_RELATIVE),
    join(packageRoot, 'prebuilds', platform, 'default', 'nodejs_whisper.node'),
  ];
}

/** Absolute paths of both artifacts for an installed `nodejs-whisper` root. */
export function whisperArtifactPaths(packageRoot: string): { cli: string; model: string } {
  return {
    cli: join(packageRoot, WHISPER_CLI_RELATIVE),
    model: join(packageRoot, WHISPER_MODEL_RELATIVE),
  };
}

/** The platform tag the package names its prebuilt addon directories by. */
function packagePlatform(require: NodeRequire, packageRoot: string): string {
  return require(join(packageRoot, 'scripts', 'native-platform.js')) as string;
}

/**
 * Probe the addon and the model. Returns all-false when `nodejs-whisper`
 * itself cannot be resolved, which is the same operational outcome: no
 * transcription.
 */
export function readVoiceReady(exists: (path: string) => boolean = existsSync): VoiceReady {
  const require = createRequire(import.meta.url);
  try {
    const packageRoot = dirname(require.resolve('nodejs-whisper/package.json'));
    const platform = packagePlatform(require, packageRoot);
    const addon = whisperAddonCandidates(packageRoot, platform).some(exists);
    return { addon, whisperCli: addon, model: exists(whisperArtifactPaths(packageRoot).model) };
  } catch {
    return { addon: false, whisperCli: false, model: false };
  }
}
