// Canonical locations of the two whisper artifacts voice input needs, relative
// to the installed `nodejs-whisper` package root.
//
// `npm ci` restores the package but NOT the compiled binary: the CMake build
// output under `cpp/whisper.cpp/build/` is created on first use by
// nodejs-whisper's own auto-download path, so a clean install leaves voice
// silently dead until something rebuilds it (VW-155).
//
// Mirrored in TypeScript at src/voice/whisper-paths.ts for `server.health`;
// src/voice/__tests__/whisper-paths.test.ts asserts the two copies agree.

/** Compiled whisper.cpp CLI that `nodejs-whisper` shells out to. */
export const WHISPER_CLI_RELATIVE = 'cpp/whisper.cpp/build/bin/whisper-cli';

/** GGML weights for `tiny.en` — the model the voice listener defaults to. */
export const WHISPER_MODEL_RELATIVE = 'cpp/whisper.cpp/models/ggml-tiny.en.bin';

/** Absolute paths of both artifacts for an installed `nodejs-whisper` root. */
export function whisperArtifactPaths(packageRoot) {
  const join = (rel) => `${packageRoot.replace(/\/$/, '')}/${rel}`;
  return { cli: join(WHISPER_CLI_RELATIVE), model: join(WHISPER_MODEL_RELATIVE) };
}

/**
 * Decide what `ensure-whisper` should do, given a probe of the environment.
 * Pure: every input is data, so the decision table is testable without a
 * filesystem or a toolchain.
 */
export function decideWhisperAction({ cliPresent, cmakePresent, env = {} }) {
  if (cliPresent) {
    return { action: 'present', reason: 'whisper-cli already built' };
  }
  if (env.VMCP_SKIP_WHISPER_BUILD === '1') {
    return { action: 'skip', reason: 'VMCP_SKIP_WHISPER_BUILD=1' };
  }
  if (env.CI) {
    return { action: 'skip', reason: 'CI=1 (voice input is not exercised in CI)' };
  }
  if (!cmakePresent) {
    return { action: 'skip', reason: 'cmake not on PATH' };
  }
  return { action: 'build', reason: 'whisper-cli missing' };
}
