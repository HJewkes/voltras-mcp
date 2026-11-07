// Boundary test for the default STT path (VW-961). The real `nodejs-whisper`
// is never loaded: a fake module stands in, so no model is downloaded and no
// native addon or CLI runs.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

import { defaultPrewarm, defaultWhisper, type WhisperModule } from '../voice-listener.js';

interface Call {
  path: string;
  opts: Record<string, unknown>;
  wavExisted: boolean;
  wavHeader: string;
}

function fakeWhisper(text: string): { module: WhisperModule; calls: Call[] } {
  const calls: Call[] = [];
  const module: WhisperModule = {
    transcribeDetailed: async (path, opts) => {
      const wavExisted = existsSync(path);
      const wavHeader = wavExisted ? readFileSync(path).subarray(0, 4).toString('ascii') : '';
      calls.push({ path, opts, wavExisted, wavHeader });
      return { text };
    },
  };
  return { module, calls };
}

describe('default whisper STT boundary', () => {
  it('transcribes a wav written for the call with the requested model', async () => {
    const { module, calls } = fakeWhisper(' Stop the set.');
    const whisper = defaultWhisper(() => module);

    const result = await whisper(Buffer.alloc(3200), 'tiny.en');

    expect(result).toEqual({ transcript: 'Stop the set.' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.wavExisted).toBe(true);
    expect(calls[0]?.wavHeader).toBe('RIFF');
    expect(calls[0]?.opts).toMatchObject({
      modelName: 'tiny.en',
      autoDownloadModelName: 'tiny.en',
    });
  });

  it('strips non-speech tags from the transcript text', async () => {
    const { module } = fakeWhisper(' [BLANK_AUDIO] wait stop');
    const whisper = defaultWhisper(() => module);

    expect(await whisper(Buffer.alloc(320), 'tiny.en')).toEqual({ transcript: 'wait stop' });
  });

  it('keeps whisper output off stdout by passing its own logger', async () => {
    const { module, calls } = fakeWhisper('');
    const whisper = defaultWhisper(() => module);

    await whisper(Buffer.alloc(320), 'tiny.en');

    const logger = calls[0]?.opts.logger;
    expect(logger).toBeDefined();
    expect(logger).not.toBe(console);
  });

  it('removes the temporary wav once transcription finishes', async () => {
    const { module, calls } = fakeWhisper('go');
    const whisper = defaultWhisper(() => module);

    await whisper(Buffer.alloc(320), 'tiny.en');

    expect(existsSync(calls[0]?.path ?? '')).toBe(false);
  });

  it('matches the installed package, which exports the function it calls', () => {
    const installed = createRequire(import.meta.url)('nodejs-whisper') as Record<string, unknown>;

    expect(typeof installed.transcribeDetailed).toBe('function');
  });

  it('pre-warms with an empty transcript on silence without throwing', async () => {
    const { module, calls } = fakeWhisper('');
    const prewarm = defaultPrewarm(defaultWhisper(() => module));

    await expect(prewarm('tiny.en')).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
