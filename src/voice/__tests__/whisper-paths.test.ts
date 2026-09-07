// Unit tests for the whisper artifact probe (src/voice/whisper-paths.ts) and
// for its install-time twin, scripts/lib/whisper-paths.mjs.
//
// The two copies exist because the install-time rebuild runs before `dist/`
// exists. They must not drift, so the first test pins them together.
import { describe, expect, it } from 'vitest';

import {
  WHISPER_CLI_RELATIVE,
  WHISPER_MODEL_RELATIVE,
  readVoiceReady,
  whisperArtifactPaths,
} from '../whisper-paths.js';
import {
  WHISPER_CLI_RELATIVE as SCRIPT_CLI,
  WHISPER_MODEL_RELATIVE as SCRIPT_MODEL,
  decideWhisperAction,
} from '../../../scripts/lib/whisper-paths.mjs';

describe('whisper artifact paths', () => {
  it('agrees with the install-time copy in scripts/lib', () => {
    expect(WHISPER_CLI_RELATIVE).toBe(SCRIPT_CLI);
    expect(WHISPER_MODEL_RELATIVE).toBe(SCRIPT_MODEL);
  });

  it('anchors both artifacts under the nodejs-whisper package root', () => {
    const paths = whisperArtifactPaths('/pkgs/nodejs-whisper');
    expect(paths.cli).toBe(`/pkgs/nodejs-whisper/${WHISPER_CLI_RELATIVE}`);
    expect(paths.model).toBe(`/pkgs/nodejs-whisper/${WHISPER_MODEL_RELATIVE}`);
  });
});

describe('readVoiceReady', () => {
  it('reports each artifact independently', () => {
    const ready = readVoiceReady((path) => path.endsWith('whisper-cli'));
    expect(ready).toEqual({ whisperCli: true, model: false });
  });

  it('reports not-ready when neither artifact is on disk', () => {
    expect(readVoiceReady(() => false)).toEqual({ whisperCli: false, model: false });
  });
});

describe('decideWhisperAction', () => {
  const buildable = { cliPresent: false, cmakePresent: true, env: {} };

  it('builds when the binary is missing and cmake is available', () => {
    expect(decideWhisperAction(buildable).action).toBe('build');
  });

  it('does nothing when the binary is already built', () => {
    expect(decideWhisperAction({ ...buildable, cliPresent: true }).action).toBe('present');
  });

  it('skips when cmake is absent so `npm ci` stays green', () => {
    const decision = decideWhisperAction({ ...buildable, cmakePresent: false });
    expect(decision).toEqual({ action: 'skip', reason: 'cmake not on PATH' });
  });

  it('skips on CI, where voice input is never exercised', () => {
    expect(decideWhisperAction({ ...buildable, env: { CI: 'true' } }).action).toBe('skip');
  });

  it('honours VMCP_SKIP_WHISPER_BUILD=1 even when a build is possible', () => {
    const decision = decideWhisperAction({ ...buildable, env: { VMCP_SKIP_WHISPER_BUILD: '1' } });
    expect(decision).toEqual({ action: 'skip', reason: 'VMCP_SKIP_WHISPER_BUILD=1' });
  });

  it('reports an existing binary as present regardless of the skip switches', () => {
    // Otherwise a skip switch would print "voice will not work" over a healthy
    // install, which is the same kind of misleading silence the gate exists for.
    const env = { CI: '1', VMCP_SKIP_WHISPER_BUILD: '1' };
    expect(decideWhisperAction({ cliPresent: true, cmakePresent: false, env })).toEqual({
      action: 'present',
      reason: 'whisper-cli already built',
    });
  });
});
