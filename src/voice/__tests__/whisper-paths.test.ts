// Unit tests for the whisper artifact probe (src/voice/whisper-paths.ts) and
// for its install-time twin, scripts/lib/whisper-paths.mjs.
//
// The two copies exist because the install-time rebuild runs before `dist/`
// exists. They must not drift, so the first test pins them together.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  whisperAddonCandidates,
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

describe('addon candidates', () => {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve('nodejs-whisper/package.json'));
  const platform = require(`${packageRoot}/scripts/native-platform.js`) as string;
  const { findNativeAddon } = require('nodejs-whisper/dist/native.js') as {
    findNativeAddon: (withCuda?: boolean) => string | undefined;
  };
  const candidates = whisperAddonCandidates(packageRoot, platform);

  afterEach(() => vi.restoreAllMocks());

  it('lists the same files, in the same order, as the package finder', () => {
    const probed: string[] = [];
    vi.spyOn(fs, 'existsSync').mockImplementation((path) => {
      probed.push(String(path));
      return false;
    });
    findNativeAddon(false);
    expect(probed).toEqual(candidates);
  });

  it('prefers the local build over the prebuilt addon, as the package finder does', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    expect(findNativeAddon(false)).toBe(candidates[0]);
  });
});

describe('readVoiceReady', () => {
  const isModel = (path: string): boolean => path.endsWith(WHISPER_MODEL_RELATIVE);
  const finder = (path: string) => (): string | undefined => path;

  it('is ready when the addon and model exist even though the CLI binary is absent', () => {
    const ready = readVoiceReady(isModel, finder('/a.node'));
    expect(ready).toEqual({ addon: true, whisperCli: true, model: true });
  });

  it('is not ready when the finder reports no addon, even with the model present', () => {
    const ready = readVoiceReady(() => true, finder(undefined as never));
    expect(ready.addon).toBe(false);
    expect(ready.whisperCli).toBe(false);
    expect(ready.model).toBe(true);
  });

  it('reports a missing model separately from the addon', () => {
    const ready = readVoiceReady(() => false, finder('/a.node'));
    expect(ready).toEqual({ addon: true, whisperCli: true, model: false });
  });

  it('reports not-ready when nothing is on disk', () => {
    expect(readVoiceReady(() => false, finder(undefined as never))).toEqual({
      addon: false,
      whisperCli: false,
      model: false,
    });
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
