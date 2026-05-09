// Unit tests for `system.speak` (src/tools/tts-tools.ts).
//
// The handler shells out to macOS's `say` binary; tests mock `child_process.spawn`
// so they never invoke real audio output and run on any host. We exercise the
// behaviors the model and the user care about: schema bounds, arg ordering,
// interrupt semantics, platform gating, and blocking-vs-fire-and-forget.

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@voltras/node-sdk', () => ({}));

const { registerSystemTools, __resetSpeakState } = await import('../tts-tools.js');

import type { ChildProcess } from 'node:child_process';
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MutableVoiceListener, VoiceListenerRef } from '../tts-tools.js';
import type { ToolResult } from '../helpers.js';

type Callback = (args: unknown, extra?: unknown) => Promise<ToolResult>;

class FakeChild extends EventEmitter {
  killed = false;
  readonly killSignals: NodeJS.Signals[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    if (typeof signal === 'string') this.killSignals.push(signal);
    return true;
  }
  emitExit(code: number | null): void {
    this.emit('exit', code);
  }
  emitError(err: Error): void {
    this.emit('error', err);
  }
}

interface SpawnCall {
  command: string;
  args: ReadonlyArray<string>;
}

interface Harness {
  invoke: Callback;
  spawnCalls: SpawnCall[];
  children: FakeChild[];
  setNextChild: (child: FakeChild | null) => void;
  setSpawnError: (err: Error | null) => void;
}

function buildHarness(platform: NodeJS.Platform): Harness {
  const spawnCalls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  let nextChild: FakeChild | null = null;
  let spawnError: Error | null = null;

  const fakeSpawn = (command: string, args: ReadonlyArray<string>): ChildProcess => {
    spawnCalls.push({ command, args });
    if (spawnError !== null) throw spawnError;
    const child = nextChild ?? new FakeChild();
    nextChild = null;
    children.push(child);
    return child as unknown as ChildProcess;
  };

  const slot: { callback?: Callback } = {};
  const placeholders = new Map<string, RegisteredTool>();
  placeholders.set('system.speak', {
    update: ({ callback }: { callback?: Callback }) => {
      if (callback !== undefined) slot.callback = callback;
    },
  } as unknown as RegisteredTool);

  registerSystemTools({} as McpServer, placeholders, {
    platform,
    spawn: fakeSpawn,
  });

  if (slot.callback === undefined) {
    throw new Error('callback was not registered');
  }

  return {
    invoke: slot.callback,
    spawnCalls,
    children,
    setNextChild: (child) => {
      nextChild = child;
    },
    setSpawnError: (err) => {
      spawnError = err;
    },
  };
}

function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe('system.speak — schema validation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness('darwin');
  });

  afterEach(() => {
    __resetSpeakState();
  });

  it('rejects missing text with INVALID_INPUT', async () => {
    const result = await harness.invoke({});
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects empty text', async () => {
    const result = await harness.invoke({ text: '' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects text longer than 500 characters', async () => {
    const result = await harness.invoke({ text: 'a'.repeat(501) });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects text containing a NUL byte', async () => {
    const result = await harness.invoke({ text: `hello${String.fromCharCode(0)}world` });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects rate below 100 wpm', async () => {
    const result = await harness.invoke({ text: 'hi', rate: 50 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects rate above 500 wpm', async () => {
    const result = await harness.invoke({ text: 'hi', rate: 600 });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects unknown extra fields (strict schema)', async () => {
    const result = await harness.invoke({ text: 'hi', bogus: true });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('accepts the minimal { text } shape', async () => {
    const result = await harness.invoke({ text: 'hello' });
    expect(result.isError).toBeUndefined();
    expect(payload(result)).toEqual({ ok: true });
  });
});

describe('system.speak — spawn arguments', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness('darwin');
  });

  afterEach(() => {
    __resetSpeakState();
  });

  it('passes only the text when no optional args are provided', async () => {
    await harness.invoke({ text: 'rest is up' });
    expect(harness.spawnCalls).toHaveLength(1);
    const call = harness.spawnCalls[0]!;
    expect(call.command).toBe('say');
    expect(call.args).toEqual(['rest is up']);
  });

  it('orders -v <voice> before the text when voice is provided', async () => {
    await harness.invoke({ text: 'hello', voice: 'Samantha' });
    expect(harness.spawnCalls[0]!.args).toEqual(['-v', 'Samantha', 'hello']);
  });

  it('orders -r <rate> before the text when rate is provided', async () => {
    await harness.invoke({ text: 'hello', rate: 200 });
    expect(harness.spawnCalls[0]!.args).toEqual(['-r', '200', 'hello']);
  });

  it('combines voice and rate ahead of the text', async () => {
    await harness.invoke({ text: 'hello', voice: 'Daniel', rate: 175 });
    expect(harness.spawnCalls[0]!.args).toEqual(['-v', 'Daniel', '-r', '175', 'hello']);
  });

  it('passes the text as a single arg, not interpolated into a shell string', async () => {
    // spawn-without-shell means metacharacters are inert; this just confirms
    // we never accidentally swap in `exec` semantics.
    await harness.invoke({ text: 'rm -rf / ; echo pwned' });
    expect(harness.spawnCalls[0]!.args).toEqual(['rm -rf / ; echo pwned']);
  });
});

describe('system.speak — interrupt behavior', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness('darwin');
  });

  afterEach(() => {
    __resetSpeakState();
  });

  it('does not signal a prior child by default', async () => {
    const first = new FakeChild();
    harness.setNextChild(first);
    await harness.invoke({ text: 'first' });

    const second = new FakeChild();
    harness.setNextChild(second);
    await harness.invoke({ text: 'second' });

    expect(first.killed).toBe(false);
  });

  it('sends SIGTERM to a still-running prior child when interrupt:true', async () => {
    const first = new FakeChild();
    harness.setNextChild(first);
    await harness.invoke({ text: 'first' });

    const second = new FakeChild();
    harness.setNextChild(second);
    await harness.invoke({ text: 'second', interrupt: true });

    expect(first.killed).toBe(true);
    expect(first.killSignals).toContain('SIGTERM');
  });

  it('does not throw if the prior child has already exited before interrupt fires', async () => {
    const first = new FakeChild();
    harness.setNextChild(first);
    await harness.invoke({ text: 'first' });
    first.emitExit(0); // clears the in-flight tracking via the exit listener

    const second = new FakeChild();
    harness.setNextChild(second);
    await expect(harness.invoke({ text: 'second', interrupt: true })).resolves.toMatchObject({});
    expect(first.killed).toBe(false);
  });
});

describe('system.speak — blocking vs fire-and-forget', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = buildHarness('darwin');
  });

  afterEach(() => {
    __resetSpeakState();
  });

  it('returns immediately when blocking is omitted', async () => {
    const child = new FakeChild();
    harness.setNextChild(child);
    const result = await harness.invoke({ text: 'go' });
    // child never emitted exit — call still resolved.
    expect(payload(result)).toEqual({ ok: true });
  });

  it('awaits child exit when blocking:true', async () => {
    const child = new FakeChild();
    harness.setNextChild(child);
    let settled = false;
    const promise = harness.invoke({ text: 'go', blocking: true }).then((r) => {
      settled = true;
      return r;
    });
    // Wait a microtask so the handler has had a chance to register listeners
    // and (critically) reach its return point. We expect it NOT to have.
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emitExit(0);
    const result = await promise;
    expect(payload(result)).toEqual({ ok: true });
  });

  it('returns TTS_FAILED when blocking and child exits non-zero', async () => {
    const child = new FakeChild();
    harness.setNextChild(child);
    const promise = harness.invoke({ text: 'go', blocking: true });
    child.emitExit(2);
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'TTS_FAILED' });
  });

  it('returns TTS_NOT_AVAILABLE when blocking and child errors with ENOENT', async () => {
    const child = new FakeChild();
    harness.setNextChild(child);
    const promise = harness.invoke({ text: 'go', blocking: true });
    const err = Object.assign(new Error('spawn say ENOENT'), { code: 'ENOENT' });
    child.emitError(err);
    const result = await promise;
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'TTS_NOT_AVAILABLE' });
  });
});

describe('system.speak — platform gating', () => {
  afterEach(() => {
    __resetSpeakState();
  });

  it('returns TTS_NOT_SUPPORTED on linux', async () => {
    const harness = buildHarness('linux');
    const result = await harness.invoke({ text: 'hello' });
    expect(result.isError).toBe(true);
    const body = payload(result);
    expect(body.code).toBe('TTS_NOT_SUPPORTED');
    expect(String(body.message)).toContain('linux');
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it('returns TTS_NOT_SUPPORTED on win32', async () => {
    const harness = buildHarness('win32');
    const result = await harness.invoke({ text: 'hello' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'TTS_NOT_SUPPORTED' });
  });

  it('returns TTS_NOT_AVAILABLE when spawn throws synchronously on darwin', async () => {
    const harness = buildHarness('darwin');
    harness.setSpawnError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    const result = await harness.invoke({ text: 'hello' });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ code: 'TTS_NOT_AVAILABLE' });
  });
});

// ── TTS ducking — mute/unmute integration ────────────────────────────────────

function makeFakeVoiceListener(): MutableVoiceListener & { muteCalls: number; unmuteCalls: number } {
  let muteCalls = 0;
  let unmuteCalls = 0;
  return {
    get muteCalls() {
      return muteCalls;
    },
    get unmuteCalls() {
      return unmuteCalls;
    },
    mute: () => {
      muteCalls += 1;
    },
    unmute: () => {
      unmuteCalls += 1;
    },
  };
}

function buildDuckingHarness(voiceListener: MutableVoiceListener | null): {
  invoke: Callback;
  children: FakeChild[];
  setNextChild: (child: FakeChild | null) => void;
  setSpawnError: (err: Error | null) => void;
} {
  const children: FakeChild[] = [];
  let nextChild: FakeChild | null = null;
  let spawnError: Error | null = null;

  const fakeSpawn = (command: string, args: ReadonlyArray<string>): ChildProcess => {
    void command;
    void args;
    if (spawnError !== null) throw spawnError;
    const child = nextChild ?? new FakeChild();
    nextChild = null;
    children.push(child);
    return child as unknown as ChildProcess;
  };

  const ref: VoiceListenerRef = { listener: voiceListener };
  const slot: { callback?: Callback } = {};
  const placeholders = new Map<string, RegisteredTool>();
  placeholders.set('system.speak', {
    update: ({ callback }: { callback?: Callback }) => {
      if (callback !== undefined) slot.callback = callback;
    },
  } as unknown as RegisteredTool);

  registerSystemTools({} as McpServer, placeholders, { platform: 'darwin', spawn: fakeSpawn }, ref);

  if (slot.callback === undefined) throw new Error('callback was not registered');

  return {
    invoke: slot.callback,
    children,
    setNextChild: (c) => {
      nextChild = c;
    },
    setSpawnError: (e) => {
      spawnError = e;
    },
  };
}

describe('system.speak — TTS ducking (mute/unmute)', () => {
  afterEach(() => {
    __resetSpeakState();
  });

  it('calls mute() before spawning say and unmute() after exit (fire-and-forget)', async () => {
    const vl = makeFakeVoiceListener();
    const harness = buildDuckingHarness(vl);
    const child = new FakeChild();
    harness.setNextChild(child);

    await harness.invoke({ text: 'rest is up' });

    // mute should have fired before spawn (call count 1 at this point)
    expect(vl.muteCalls).toBe(1);
    // unmute fires on child exit — not yet
    expect(vl.unmuteCalls).toBe(0);

    child.emitExit(0);
    expect(vl.unmuteCalls).toBe(1);
  });

  it('calls unmute() after exit in blocking mode (success)', async () => {
    const vl = makeFakeVoiceListener();
    const harness = buildDuckingHarness(vl);
    const child = new FakeChild();
    harness.setNextChild(child);

    const promise = harness.invoke({ text: 'two reps left', blocking: true });
    expect(vl.muteCalls).toBe(1);

    child.emitExit(0);
    await promise;

    expect(vl.unmuteCalls).toBe(1);
  });

  it('calls unmute() even when say exits with non-zero code (blocking)', async () => {
    const vl = makeFakeVoiceListener();
    const harness = buildDuckingHarness(vl);
    const child = new FakeChild();
    harness.setNextChild(child);

    const promise = harness.invoke({ text: 'ease in', blocking: true });
    child.emitExit(1);
    const result = await promise;

    expect(result.isError).toBe(true);
    expect(vl.unmuteCalls).toBe(1);
  });

  it('calls unmute() when spawn fails (TTS_NOT_AVAILABLE path)', async () => {
    const vl = makeFakeVoiceListener();
    const harness = buildDuckingHarness(vl);
    harness.setSpawnError(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));

    const result = await harness.invoke({ text: 'hello' });

    expect(result.isError).toBe(true);
    expect(vl.muteCalls).toBe(1);
    expect(vl.unmuteCalls).toBe(1);
  });

  it('works without a voice listener (no error thrown, null ref)', async () => {
    const harness = buildDuckingHarness(null);
    const child = new FakeChild();
    harness.setNextChild(child);

    const result = await harness.invoke({ text: 'hello' });
    child.emitExit(0);
    expect(result.isError).toBeUndefined();
  });

  it('works when registerSystemTools is called without a voiceListenerRef', async () => {
    const slot: { callback?: Callback } = {};
    const placeholders = new Map<string, RegisteredTool>();
    const children: FakeChild[] = [];
    placeholders.set('system.speak', {
      update: ({ callback }: { callback?: Callback }) => {
        if (callback !== undefined) slot.callback = callback;
      },
    } as unknown as RegisteredTool);

    const fakeSpawn = (): ChildProcess => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    };

    registerSystemTools({} as McpServer, placeholders, { platform: 'darwin', spawn: fakeSpawn });

    const result = await slot.callback!({ text: 'no listener' });
    children[0]!.emitExit(0);
    expect(result.isError).toBeUndefined();
  });
});
