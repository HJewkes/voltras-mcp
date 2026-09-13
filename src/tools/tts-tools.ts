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
//     lets a new cue cut off a still-playing one.
//   * `blocking: true` awaits the child's `exit` event before returning so
//     the caller can chain on completion; a queued fire-and-forget call
//     resolves once it has been spawned, not once it has finished playing.
//
// Serialisation (VW-170):
//   * `say` does not queue: two overlapping spawns play over each other, and
//     an auto cue landing on top of a `system.speak` line makes both
//     unintelligible. Every caller lands in `speak()`, so ONE module-scope
//     queue here serialises both — a call waits for the previous utterance's
//     child to exit before its own `say` is spawned. Order is the order the
//     calls were made: a slot is reserved synchronously.
//   * `interrupt: true` is the cancel/flush path and deliberately skips the
//     queue: it kills the playing child, drops everything still waiting, and
//     speaks now. That is what keeps the Tier-A stop-phrase ack immediate
//     (VW-173) — it must never wait behind a cue. A dropped queue entry
//     returns `ok: true` with `spoken: false`.
//
// Failure shape:
//   * Non-darwin → `TTS_NOT_SUPPORTED`.
//   * `say` not found (PATH issue or stripped install) → `TTS_NOT_AVAILABLE`.
//   * Non-zero exit only surfaces in `blocking: true` mode — fire-and-forget
//     callers won't see late errors, by design (we don't want a crashing
//     `say` invocation to blow up later in the conversation).

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { log } from '../logger.js';
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

/** Minimal surface we need from VoiceListener — avoids a circular import. */
export interface MutableVoiceListener {
  mute(): void;
  unmute(): void;
}

/**
 * Holder that the speak callback reads at call time so it always sees the
 * current listener even if it was armed after `registerSystemTools` ran.
 */
export interface VoiceListenerRef {
  readonly listener: MutableVoiceListener | null;
}

/**
 * Where a spoken line goes so the wall can caption it (VW-289). Called once per
 * utterance that actually started playing — never for a rejected or unspawnable
 * one. Wired to `publishCoachLine`; absent in tests and off-darwin.
 */
export type CoachLineSink = (line: { text: string; source: string; occurredAt: number }) => void;

/** The default `source` on a coach line: a `system.speak` call, not a cue. */
export const SPEAK_LINE_SOURCE = 'speak';

export interface SpeakDeps {
  readonly platform: NodeJS.Platform;
  readonly spawn: SpawnFn;
  /** Optional — resolved at call time so late-armed listeners are seen. */
  readonly voiceListenerRef?: VoiceListenerRef | null;
  /** Optional — see {@link CoachLineSink}. Speech works unchanged without one. */
  readonly coachLine?: CoachLineSink | null;
}

const DEFAULT_DEPS: SpeakDeps = {
  platform: process.platform,
  spawn: spawn as SpawnFn,
};

let inFlight: ChildProcess | null = null;

/**
 * Tail of the speech queue: resolves when the last-reserved utterance has
 * stopped occupying the speaker. A new caller chains onto it.
 */
let queueTail: Promise<void> = Promise.resolve();

/** Bumped by every flush; a waiter whose generation is stale does not speak. */
let queueGeneration = 0;

/** Utterances holding or awaiting the speaker. Zero means "speak now". */
let queueDepth = 0;

/** Test-only: clear the in-flight child and the speech queue between cases. */
export function __resetSpeakState(): void {
  inFlight = null;
  queueTail = Promise.resolve();
  queueGeneration += 1;
  queueDepth = 0;
}

/**
 * Hard ceiling on how long a single `speak()` call may hold the mic muted.
 * `unmute()` is normally driven by the child's `exit`/`error` events, but a
 * `say` process that hangs (or whose events are lost) would otherwise mute
 * the mic — and with it the ungated safety-phrase fast-path — forever. This
 * is a failsafe, not the expected path: any real cue finishes in well under
 * this window.
 */
const MUTE_FAILSAFE_MS = 8000;

/**
 * Mute now, and guarantee a matching unmute fires exactly once — either from
 * the caller-driven path (child exit/error, or the blocking `finally`) or,
 * failing that, from a hard timeout. Guards against double-unmute (which
 * would under-count VoiceListener's refcount) if both paths fire.
 */
function muteWithFailsafe(voiceListener: MutableVoiceListener | null): () => void {
  if (voiceListener === null) return () => {};
  voiceListener.mute();
  let unmuted = false;
  const timer = setTimeout(() => {
    if (unmuted) return;
    unmuted = true;
    log.warn(`speak(): mute failsafe fired after ${MUTE_FAILSAFE_MS}ms — forcing unmute`);
    voiceListener.unmute();
  }, MUTE_FAILSAFE_MS);
  timer.unref?.();
  return () => {
    if (unmuted) return;
    unmuted = true;
    clearTimeout(timer);
    voiceListener.unmute();
  };
}

const TOOL_DESCRIPTION = [
  'Speak a short coaching cue aloud through the host machine. macOS only —',
  'shells out to the built-in `say` binary. Use this for verbal workout',
  'prompts ("rest is up", "two reps to go", "ease into the eccentric") so',
  'the user can keep their eyes on the device instead of the chat.',
  '',
  'Default behavior is fire-and-forget: the call returns as soon as `say`',
  'has been spawned. Pass `blocking: true` to await playback completion.',
  '',
  'Spoken output is serialised: this tool and the automatic coaching cues',
  'share one queue, so lines never play over each other. A call made while',
  'another line is playing waits its turn, and so returns late rather than',
  'immediately — expect the call to take as long as whatever is ahead of it.',
  'Pass `interrupt: true` to skip the queue instead: it cuts off the playing',
  'line, drops the lines still waiting, and speaks now. A dropped line',
  'returns `ok: true` with `spoken: false` — nothing was said and nothing',
  'failed. Use it only when the new line makes the queued ones pointless.',
  '',
  'Playback mutes the local voice listener, if one is armed: mic frames are',
  'discarded (not buffered) for the duration of the cue, and any utterance',
  'already in progress is dropped when the mute starts. The user cannot barge',
  'in while a cue plays — anything they say, including a safety phrase, is',
  'lost. Keep cues short, and do not speak when you are waiting on a spoken',
  'reply. A hard 8s failsafe caps the mute window even if `say` hangs.',
].join(' ');

/**
 * Hot-swap the `system.speak` placeholder with the real handler. Mirrors the
 * install pattern used by the other tool registries.
 *
 * Pass `voiceListenerRef` so `system.speak` can mute/unmute around TTS
 * playback — the ref is read at call time so listeners armed after registration
 * are included. When absent or null, speak still works; muting is a no-op.
 *
 * Pass `coachLine` so each spoken line reaches the wall caption (VW-289).
 */
export function registerSystemTools(
  _server: McpServer,
  placeholders: PlaceholderTools,
  deps: SpeakDeps = DEFAULT_DEPS,
  voiceListenerRef?: VoiceListenerRef | null,
  coachLine?: CoachLineSink | null,
): void {
  const tool = placeholders.get('system.speak');
  if (tool === undefined) {
    throw new Error('tool placeholder not registered: system.speak');
  }
  const effectiveDeps: SpeakDeps = {
    ...deps,
    ...(voiceListenerRef != null ? { voiceListenerRef } : {}),
    ...(coachLine != null ? { coachLine } : {}),
  };
  tool.update({
    description: TOOL_DESCRIPTION,
    paramsSchema: SystemSpeakInput.shape,
    callback: makeSpeakCallback(effectiveDeps),
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
    return speak(parsed.data, deps);
  };
}

function buildSayArgs(input: SystemSpeakInputType): string[] {
  const args: string[] = [];
  if (input.voice !== undefined) args.push('-v', input.voice);
  if (input.rate !== undefined) args.push('-r', String(input.rate));
  args.push(input.text);
  return args;
}

/**
 * Speak `input.text` aloud. `source` names what asked for it — a cue category
 * for the emitter, {@link SPEAK_LINE_SOURCE} for a `system.speak` call — and
 * rides the `coach_line` push event so the wall caption can say where the line
 * came from. Both callers land here, which is why the event is emitted at this
 * one point rather than at either of them.
 */
export async function speak(
  input: SystemSpeakInputType,
  deps: SpeakDeps,
  source: string = SPEAK_LINE_SOURCE,
): Promise<ToolResult> {
  if (input.interrupt) interruptInFlight();
  return schedule(() => play(input, deps, source), input.interrupt);
}

/** One utterance's tool result, plus when it stops occupying the speaker. */
interface Playback {
  readonly result: ToolResult;
  readonly finished: Promise<void>;
}

/**
 * Take the speaker for one utterance.
 *
 * The slot is reserved synchronously, so the play order is the call order
 * however the callers interleave. An utterance that finds the speaker free
 * spawns synchronously too — the queue costs nothing when nothing is playing.
 *
 * `jumpQueue` is the flush: it bumps the generation, which every waiter
 * checks when its turn comes, so the lines still queued are dropped rather
 * than played after the line that replaced them.
 */
function schedule(startPlayback: () => Promise<Playback>, jumpQueue: boolean): Promise<ToolResult> {
  const turn = jumpQueue || queueDepth === 0 ? null : queueTail;
  const generation = jumpQueue ? ++queueGeneration : queueGeneration;
  queueDepth += 1;
  let release!: () => void;
  queueTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = (): void => {
    queueDepth -= 1;
    release();
  };
  return turn === null
    ? runTurn(startPlayback, done, generation)
    : turn.then(() => runTurn(startPlayback, done, generation));
}

async function runTurn(
  startPlayback: () => Promise<Playback>,
  done: () => void,
  generation: number,
): Promise<ToolResult> {
  if (generation !== queueGeneration) {
    done();
    return textResult({ ok: true, spoken: false });
  }
  try {
    const playback = await startPlayback();
    void playback.finished.then(done, done);
    return playback.result;
  } catch (err) {
    done();
    throw err;
  }
}

async function play(
  input: SystemSpeakInputType,
  deps: SpeakDeps,
  source: string,
): Promise<Playback> {
  const voiceListener = deps.voiceListenerRef?.listener ?? null;
  const unmuteOnce = muteWithFailsafe(voiceListener);

  const child = trySpawn(deps, buildSayArgs(input));
  if (child === null) {
    unmuteOnce();
    return {
      result: errorResult({
        code: 'TTS_NOT_AVAILABLE',
        message: '`say` binary not found on PATH; macOS TTS is unavailable.',
      }),
      finished: Promise.resolve(),
    };
  }
  emitCoachLine(deps, input.text, source);
  inFlight = child;
  child.once('exit', () => {
    if (inFlight === child) inFlight = null;
  });
  child.once('error', () => {
    if (inFlight === child) inFlight = null;
  });

  if (input.blocking) {
    // awaitExit resolves after child exits (success or error). Unmute in a
    // finally so mute leaks are impossible regardless of exit code or thrown error.
    // The speaker is already free by then, so the queue slot frees immediately.
    try {
      return { result: await awaitExit(child), finished: Promise.resolve() };
    } finally {
      unmuteOnce();
    }
  }

  // Fire-and-forget: unmute when the child process exits. We register a
  // dedicated 'exit' listener (separate from the in-flight tracking one
  // already registered above) so unmute fires even if the caller ignores the
  // result. 'error' also triggers unmute because spawn-ENOENT surfaces as an
  // 'error' event and the child never emits 'exit'.
  child.once('exit', unmuteOnce);
  child.once('error', unmuteOnce);

  return { result: textResult({ ok: true }), finished: whenPlaybackEnds(child) };
}

/**
 * Resolves when `child` stops making sound. The timeout mirrors the mute
 * failsafe for the same reason: a `say` that hangs, or whose events are lost,
 * must not hold the queue shut on every cue that follows it.
 */
function whenPlaybackEnds(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, MUTE_FAILSAFE_MS);
    timer.unref?.();
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);
    child.once('error', done);
  });
}

/**
 * Announce a line that is now playing. Blank text is dropped — `say` with an
 * empty string makes no sound, so captioning it would put an empty box on the
 * wall. A throwing sink is swallowed: a caption must never break the cue.
 */
function emitCoachLine(deps: SpeakDeps, text: string, source: string): void {
  if (deps.coachLine == null || text.trim() === '') return;
  try {
    deps.coachLine({ text, source, occurredAt: Date.now() });
  } catch {
    // Best-effort, exactly like the cue tee's own swallow.
  }
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
