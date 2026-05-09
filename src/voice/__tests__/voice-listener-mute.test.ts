// Unit tests for VoiceListener.mute() / .unmute() — TTS ducking.
//
// Verifies that wake events arriving while the listener is muted are
// suppressed (no transcription enqueued) and that audio buffered during the
// muted window is not replayed after unmute.

import { EventEmitter, PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

import {
  VoiceListener,
  type AudioSource,
  type StartArgs,
  type WakeSidecar,
} from '../voice-listener.js';

// ── Shared fakes ─────────────────────────────────────────────────────────────

function makeFakeAudio(): AudioSource {
  const stream = new PassThrough();
  return {
    stream,
    stop: () => {},
  };
}

interface FakeSidecar extends WakeSidecar {
  emitWake: (score?: number) => void;
}

function makeFakeSidecar(): FakeSidecar {
  const stdin = new PassThrough();
  const stdout = new EventEmitter() as NodeJS.ReadableStream;
  const stderr = new EventEmitter() as NodeJS.ReadableStream;
  return {
    stdin,
    stdout,
    stderr,
    kill: () => {},
    emitWake: (score = 0.95) => {
      (stdout as unknown as EventEmitter).emit(
        'data',
        JSON.stringify({ event: 'wake', ts: Date.now(), score }) + '\n',
      );
    },
  };
}

function defaultArgs(): StartArgs {
  return {
    wakeWord: 'hey_jarvis',
    wakeWordModelPath: undefined,
    sttModel: 'base.en',
    maxUtteranceSec: 12,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('VoiceListener — mute/unmute state', () => {
  it('isMuted() returns false on a fresh listener', () => {
    const listener = new VoiceListener({
      audioFactory: makeFakeAudio,
      sidecarFactory: makeFakeSidecar,
      whisper: vi.fn(),
    });
    expect(listener.isMuted()).toBe(false);
  });

  it('mute() sets isMuted() to true', () => {
    const listener = new VoiceListener({
      audioFactory: makeFakeAudio,
      sidecarFactory: makeFakeSidecar,
      whisper: vi.fn(),
    });
    listener.mute();
    expect(listener.isMuted()).toBe(true);
  });

  it('unmute() sets isMuted() to false', () => {
    const listener = new VoiceListener({
      audioFactory: makeFakeAudio,
      sidecarFactory: makeFakeSidecar,
      whisper: vi.fn(),
    });
    listener.mute();
    listener.unmute();
    expect(listener.isMuted()).toBe(false);
  });

  it('mute() is idempotent — calling twice stays muted', () => {
    const listener = new VoiceListener({
      audioFactory: makeFakeAudio,
      sidecarFactory: makeFakeSidecar,
      whisper: vi.fn(),
    });
    listener.mute();
    listener.mute();
    expect(listener.isMuted()).toBe(true);
  });

  it('unmute() is idempotent — calling twice on unmuted stays false', () => {
    const listener = new VoiceListener({
      audioFactory: makeFakeAudio,
      sidecarFactory: makeFakeSidecar,
      whisper: vi.fn(),
    });
    listener.unmute();
    listener.unmute();
    expect(listener.isMuted()).toBe(false);
  });
});

describe('VoiceListener — muted wake-event suppression', () => {
  it('does NOT call whisper when a wake event arrives while muted', async () => {
    const sidecar = makeFakeSidecar();
    const whisper = vi.fn().mockResolvedValue({ transcript: 'hello' });
    const listener = new VoiceListener({
      audioFactory: makeFakeAudio,
      sidecarFactory: () => sidecar,
      whisper,
      timers: {
        setTimeout: vi.fn(() => ({})),
        clearTimeout: vi.fn(),
      },
    });

    await listener.start(defaultArgs());
    listener.mute();
    sidecar.emitWake();

    // Flush microtasks — whisper is async so any accidental invocation would
    // only appear after awaiting here.
    await Promise.resolve();

    expect(whisper).not.toHaveBeenCalled();
    expect(listener.getState()).toBe('listening');
  });

  it('does NOT emit onWakeWord while muted', async () => {
    const sidecar = makeFakeSidecar();
    const onWakeWord = vi.fn();
    const listener = new VoiceListener(
      {
        audioFactory: makeFakeAudio,
        sidecarFactory: () => sidecar,
        whisper: vi.fn(),
        timers: {
          setTimeout: vi.fn(() => ({})),
          clearTimeout: vi.fn(),
        },
      },
      { onWakeWord },
    );

    await listener.start(defaultArgs());
    listener.mute();
    sidecar.emitWake();

    await Promise.resolve();

    expect(onWakeWord).not.toHaveBeenCalled();
  });

  it('processes a wake event normally AFTER unmute', async () => {
    const sidecar = makeFakeSidecar();
    const whisper = vi.fn().mockResolvedValue({ transcript: 'start the set' });
    let hardCapFn: (() => void) | null = null;
    const listener = new VoiceListener({
      audioFactory: makeFakeAudio,
      sidecarFactory: () => sidecar,
      whisper,
      timers: {
        setTimeout: (cb) => {
          hardCapFn = cb;
          return {};
        },
        clearTimeout: vi.fn(),
      },
    });

    await listener.start(defaultArgs());
    listener.mute();
    sidecar.emitWake(); // suppressed

    await Promise.resolve();
    expect(listener.getState()).toBe('listening'); // stayed in listening

    listener.unmute();
    sidecar.emitWake(); // should be processed
    await Promise.resolve();

    expect(listener.getState()).toBe('buffering');

    // Fire the hard cap to flush to STT
    hardCapFn!();
    await Promise.resolve();
    await Promise.resolve();

    expect(whisper).toHaveBeenCalledTimes(1);
  });

  it('does NOT transcribe audio buffered while muted (empty transcription queue after unmute)', async () => {
    const audio = makeFakeAudio();
    const audioStream = audio.stream as PassThrough;
    const sidecar = makeFakeSidecar();
    const whisper = vi.fn().mockResolvedValue({ transcript: 'tts output' });
    const listener = new VoiceListener({
      audioFactory: () => audio,
      sidecarFactory: () => sidecar,
      whisper,
      timers: {
        setTimeout: vi.fn(() => ({})),
        clearTimeout: vi.fn(),
      },
    });

    await listener.start(defaultArgs());
    listener.mute();

    // Pump audio frames as if the speaker is playing TTS
    audioStream.push(Buffer.alloc(3200)); // 100ms of 16kHz int16 mono
    audioStream.push(Buffer.alloc(3200));
    await Promise.resolve();

    // Sidecar does NOT emit a wake while muted (represents normal suppression)
    // but even if it did, we verify state is still 'listening'
    expect(listener.getState()).toBe('listening');

    listener.unmute();

    // No whisper call — nothing was queued for transcription
    expect(whisper).not.toHaveBeenCalled();
    expect(listener.getState()).toBe('listening');
  });
});
