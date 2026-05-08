// `system.speak` — macOS text-to-speech for verbal workout cues.
//
// The personal-trainer flow benefits from spoken prompts ("rest is up", "two
// reps left", "ease into the eccentric") so the user can keep eyes on the
// device instead of glancing at the chat. Rather than ship an audio pipeline,
// we shell out to macOS's built-in `say` binary — it ships with every macOS
// install, supports voice and rate flags, and produces sound on the host's
// default output device with no additional configuration.
//
// Platform support: macOS only. Calls on any other platform fail fast with
// `TTS_NOT_SUPPORTED`. We don't try to fall back to other TTS engines — the
// scope here is "give the trainer a voice on the dev's macOS box."
//
// Process lifecycle:
//   * Each invocation spawns a fresh `say` child with `child_process.spawn`,
//     passing args separately so shell metacharacters in `text` are inert.
//   * A single in-flight child is tracked at module scope. `interrupt: true`
//     sends SIGTERM to that prior child before spawning the new one, which
//     lets a new cue cut off a still-playing one. Without `interrupt`,
//     concurrent calls layer audibly — `say` itself doesn't queue.
//   * `blocking: true` awaits the child's `exit` event before returning so
//     the caller can chain on completion; the default fire-and-forget shape
//     resolves immediately after spawn so the trainer can keep talking.
//
// Failure shape:
//   * Non-darwin → `TTS_NOT_SUPPORTED`.
//   * `say` not found (PATH issue or stripped install) → `TTS_NOT_AVAILABLE`.
//   * Non-zero exit only surfaces in `blocking: true` mode — fire-and-forget
//     callers won't see late errors, by design (we don't want a crashing
//     `say` invocation to blow up later in the conversation).

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { SystemSpeakInput, type SystemSpeakInputType } from '../schemas/system.js';
import { errorResult, textResult, type ToolResult } from './helpers.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options?: SpawnOptions,
) => ChildProcess;

interface SpeakDeps {
  readonly platform: NodeJS.Platform;
  readonly spawn: SpawnFn;
}

const DEFAULT_DEPS: SpeakDeps = {
  platform: process.platform,
  spawn: spawn as SpawnFn,
};

let inFlight: ChildProcess | null = null;

/** Test-only: clear any tracked in-flight child between cases. */
export function __resetSpeakState(): void {
  inFlight = null;
}

const TOOL_DESCRIPTION = [
  'Speak a short coaching cue aloud through the host machine. macOS only —',
  'shells out to the built-in `say` binary. Use this for verbal workout',
  'prompts ("rest is up", "two reps to go", "ease into the eccentric") so',
  'the user can keep their eyes on the device instead of the chat.',
  '',
  'Default behavior is fire-and-forget: the call returns as soon as `say`',
  'has been spawned. Pass `blocking: true` to await playback completion.',
  'Pass `interrupt: true` to cut off any still-playing cue from a previous',
  'call before this one starts — useful when a more urgent prompt needs to',
  'override an in-flight one.',
].join(' ');

/**
 * Hot-swap the `system.speak` placeholder with the real handler. Mirrors the
 * install pattern used by the other tool registries.
 */
export function registerSystemTools(
  _server: McpServer,
  placeholders: PlaceholderTools,
  deps: SpeakDeps = DEFAULT_DEPS,
): void {
  const tool = placeholders.get('system.speak');
  if (tool === undefined) {
    throw new Error('tool placeholder not registered: system.speak');
  }
  tool.update({
    description: TOOL_DESCRIPTION,
    paramsSchema: SystemSpeakInput.shape,
    callback: makeSpeakCallback(deps),
  });
}

function makeSpeakCallback(
  deps: SpeakDeps,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = SystemSpeakInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    if (deps.platform !== 'darwin') {
      return errorResult({
        code: 'TTS_NOT_SUPPORTED',
        message: `TTS requires macOS \`say\` binary; current platform: ${deps.platform}`,
      });
    }
    return runSay(parsed.data, deps);
  };
}

function buildSayArgs(input: SystemSpeakInputType): string[] {
  const args: string[] = [];
  if (input.voice !== undefined) args.push('-v', input.voice);
  if (input.rate !== undefined) args.push('-r', String(input.rate));
  args.push(input.text);
  return args;
}

async function runSay(input: SystemSpeakInputType, deps: SpeakDeps): Promise<ToolResult> {
  if (input.interrupt) interruptInFlight();

  const child = trySpawn(deps, buildSayArgs(input));
  if (child === null) {
    return errorResult({
      code: 'TTS_NOT_AVAILABLE',
      message: '`say` binary not found on PATH; macOS TTS is unavailable.',
    });
  }
  inFlight = child;
  child.once('exit', () => {
    if (inFlight === child) inFlight = null;
  });
  child.once('error', () => {
    if (inFlight === child) inFlight = null;
  });

  if (input.blocking) {
    return awaitExit(child);
  }
  return textResult({ ok: true });
}

function interruptInFlight(): void {
  if (inFlight === null) return;
  // SIGTERM gives `say` a chance to flush; if it ignores us the new cue still
  // starts playing alongside, which is acceptable.
  try {
    inFlight.kill('SIGTERM');
  } catch {
    // Already exited or otherwise unkillable — drop the reference and move on.
  }
  inFlight = null;
}

function trySpawn(deps: SpeakDeps, args: string[]): ChildProcess | null {
  try {
    return deps.spawn('say', args, { stdio: 'ignore' });
  } catch {
    return null;
  }
}

async function awaitExit(child: ChildProcess): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    child.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code === 'ENOENT' ? 'TTS_NOT_AVAILABLE' : 'TTS_FAILED';
      resolve(errorResult({ code, message: err.message }));
    });
    child.once('exit', (exitCode) => {
      if (exitCode === 0 || exitCode === null) {
        resolve(textResult({ ok: true }));
        return;
      }
      resolve(
        errorResult({
          code: 'TTS_FAILED',
          message: `\`say\` exited with code ${String(exitCode)}`,
        }),
      );
    });
  });
}
