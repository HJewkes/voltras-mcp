// `system.listen_start` / `system.listen_stop` — local voice input.
//
// The listener runs an in-process Silero VAD (onnxruntime-node) gating
// `nodejs-whisper` STT over `node-record-lpcm16` mic capture — no Python, no
// wake-word model. Every detected utterance is transcribed and routed on the
// transcript text: a `hey coach` wake phrase forwards to the model as a
// `voice_input` channel event; the always-on safety phrases (stop/unload/…)
// route through `onSafetyPhrase` (the ungated unload fast-path lands in
// VMCP-02.78; for now they also surface as `voice_input`).
//
// Off-by-default: nothing happens at boot. The user (or PT Claude) calls
// `system.listen_start` to arm the mic. `listen_stop` is idempotent.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  SystemListenStartInput,
  SystemListenStopInput,
  type SystemListenStartInputType,
} from '../schemas/voice.js';
import {
  buildDeterministicStopTriggeredPayload,
  buildVoiceInputPayload,
} from '../state/channel-payloads.js';
import type { ChannelEvent, ChannelPublisher } from '../state/channel-publisher.js';
import {
  defaultAudioFactory,
  defaultPrewarm,
  defaultVadFactory,
  defaultWhisper,
  resolveStartArgs,
  type SttModelName,
  VoiceListener,
  type VoiceListenerDeps,
} from '../voice/voice-listener.js';
import { errorResult, textResult, type ToolResult } from './helpers.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/** Slot-shaped state injection — only the fields the voice tools need. */
export interface VoiceToolState {
  channels: ChannelPublisher;
  voice: VoiceListenerHolder;
}

/**
 * Singleton holder so a single VoiceListener lives across listen_start /
 * listen_stop cycles. Sits on `ServerState` so tests can inject a fake
 * VoiceListener (or plug a fully-mocked deps bundle through `__deps`).
 */
export interface VoiceListenerHolder {
  listener: VoiceListener | null;
  /**
   * In-flight `listen_start`. Arming now waits on the mic (~530 ms, up to
   * MIC_READY_TIMEOUT_MS), so a concurrent listen_start/listen_stop has a real
   * window to land in. Both join this instead of racing it — otherwise a second
   * start opens a second sox recorder and leaks the loser, and a stop reports
   * `stopped` while the arm completes behind it and leaves the mic hot.
   */
  starting: Promise<ToolResult> | null;
  __deps: VoiceListenerDeps | null;
}

export function makeVoiceHolder(deps: VoiceListenerDeps | null = null): VoiceListenerHolder {
  return { listener: null, starting: null, __deps: deps };
}

/**
 * Server-provided hooks the Tier-A safety fast-path needs — kept minimal so
 * voice-tools stays decoupled from ServerState/device-tools. Built in server.ts
 * from `isSafetyUnloadWarranted` + `unloadSlot` + `speak`.
 */
export interface VoiceSafetyContext {
  /** Whether an emergency unload is warranted for the slot, + the active set id. */
  evaluate(slotId: string): { warranted: boolean; reason: string; setId: string | null };
  /** Unload the slot (idempotent mode-bounce that slackens the cable). */
  unload(slotId: string): Promise<void>;
  /** Speak a deterministic ack, interrupting any in-flight speech. */
  speakAck(text: string): void;
}

/** Single-arm bench flows unload the primary slot; bilateral demux is VW-48. */
const SAFETY_SLOT = 'primary';

/** Deterministic ack spoken the instant the cable is cut. */
const SAFETY_ACK_TEXT = 'Stopping. Weight off.';

/**
 * Tier-A ungated safety path: a recognized stop phrase → immediate unload when a
 * set is active/loaded, bypassing the LLM. When nothing is loaded (or the safety
 * context isn't wired, e.g. tests) the phrase still reaches the model as
 * voice_input so it can respond conversationally. On unload failure the model is
 * told so it can retry `device.unload` as the backstop.
 */
async function runSafetyFastPath(
  channels: ChannelPublisher,
  safety: VoiceSafetyContext | null,
  ev: {
    matchedPhrase: string;
    transcript: string;
    sttModel: SttModelName;
    latencyMs: number;
    audioDurationMs: number;
  },
): Promise<void> {
  const verdict = safety === null ? null : evaluateSafely(safety);
  if (safety === null || verdict === null || !verdict.warranted) {
    publishVoiceInput(channels, ev); // not loaded/active, or no safety context → let the model handle it
    return;
  }
  try {
    await safety.unload(SAFETY_SLOT);
  } catch (err) {
    publishVoiceInput(channels, ev);
    channels.publish(safetyUnloadFailedPayload(err));
    return;
  }
  safety.speakAck(SAFETY_ACK_TEXT);
  channels.publish(
    buildDeterministicStopTriggeredPayload({
      slot: SAFETY_SLOT,
      setId: verdict.setId,
      matchedPhrase: ev.matchedPhrase,
      predicateReason: verdict.reason,
    }),
  );
}

/** Run the predicate, treating a thrown getSlot (unknown slot) as "not warranted". */
function evaluateSafely(
  safety: VoiceSafetyContext,
): { warranted: boolean; reason: string; setId: string | null } | null {
  try {
    return safety.evaluate(SAFETY_SLOT);
  } catch {
    return null;
  }
}

function publishVoiceInput(
  channels: ChannelPublisher,
  ev: {
    transcript: string;
    sttModel: SttModelName;
    latencyMs: number;
    audioDurationMs: number;
  },
): void {
  channels.publish(
    buildVoiceInputPayload(ev.transcript, ev.latencyMs, ev.sttModel, ev.audioDurationMs),
  );
}

function safetyUnloadFailedPayload(err: unknown): ChannelEvent {
  const message = err instanceof Error ? err.message : String(err);
  return {
    meta: {
      source: 'voltras',
      event_type: 'voice_input_failed',
      error_code: 'SAFETY_UNLOAD_FAILED',
    },
    content: JSON.stringify({
      summary: `Safety unload FAILED — call device.unload now. ${message}`,
      error_code: 'SAFETY_UNLOAD_FAILED',
      message,
    }),
  };
}

const START_DESCRIPTION = [
  'Arm the local voice listener. Runs an in-process Silero VAD + whisper.cpp',
  'over the mic — no audio leaves the machine, no wake-word model. Say the wake',
  'phrase (`hey coach`) to address the trainer; safety phrases (stop, unload,',
  'cut the weight, …) are always-on and need no wake phrase. Default STT:',
  '`tiny.en` (low latency). Idempotent — re-arming returns the current state.',
  '',
  'The mic goes deaf during TTS: `system.speak` and the automatic cue emitter',
  'mute the listener and discard in-flight frames for the length of each cue',
  '(an utterance already in progress is dropped too), so nothing said during',
  'playback is heard — wake phrase and safety phrases alike. Each mute window',
  'is bounded by a hard 8s failsafe, and the mid-set',
  '`target_hit`/`slowdown` cues stay silent unless `VMCP_CUES_MIDSET=on`, so',
  'the blind spot normally lands only at set boundaries.',
].join(' ');

const STOP_DESCRIPTION = [
  'Tear down the voice listener. Idempotent — calling on a stopped listener',
  'succeeds quietly. Safe to invoke from a Stop button.',
].join(' ');

export function registerVoiceTools(
  _server: McpServer,
  state: VoiceToolState,
  placeholders: PlaceholderTools,
  safety: VoiceSafetyContext | null = null,
): void {
  const startTool = placeholders.get('system.listen_start');
  const stopTool = placeholders.get('system.listen_stop');
  if (startTool === undefined) {
    throw new Error('tool placeholder not registered: system.listen_start');
  }
  if (stopTool === undefined) {
    throw new Error('tool placeholder not registered: system.listen_stop');
  }
  startTool.update({
    description: START_DESCRIPTION,
    paramsSchema: SystemListenStartInput.shape,
    callback: makeStartCallback(state, safety),
  });
  stopTool.update({
    description: STOP_DESCRIPTION,
    paramsSchema: SystemListenStopInput.shape,
    callback: makeStopCallback(state),
  });
}

function makeStartCallback(
  state: VoiceToolState,
  safety: VoiceSafetyContext | null,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = SystemListenStartInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    return startListener(state, parsed.data, safety);
  };
}

function makeStopCallback(
  state: VoiceToolState,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = SystemListenStopInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    return stopListener(state);
  };
}

async function startListener(
  state: VoiceToolState,
  input: SystemListenStartInputType,
  safety: VoiceSafetyContext | null,
): Promise<ToolResult> {
  const startArgs = resolveStartArgs(input);
  if (state.voice.listener !== null && state.voice.starting === null) {
    return textResult({
      status: 'listening',
      wakePhrases: state.voice.listener.getStartArgs()?.wakePhrases ?? startArgs.wakePhrases,
      sttModel: state.voice.listener.getStartArgs()?.sttModel ?? startArgs.sttModel,
      // A listener that armed deaf stays deaf; re-arming must keep saying so.
      micReady: state.voice.listener.isMicLive(),
    });
  }
  // Re-arming mid-arm joins the arm in progress rather than opening a second
  // mic. `starting` is assigned before any await, so nothing can interleave
  // between the check and the assignment.
  if (state.voice.starting !== null) return state.voice.starting;
  const pending = armListener(state, startArgs, safety);
  state.voice.starting = pending;
  try {
    return await pending;
  } finally {
    state.voice.starting = null;
  }
}

async function armListener(
  state: VoiceToolState,
  startArgs: ReturnType<typeof resolveStartArgs>,
  safety: VoiceSafetyContext | null,
): Promise<ToolResult> {
  const deps = state.voice.__deps !== null ? state.voice.__deps : buildProductionDeps();
  const channels = state.channels;
  const listener = new VoiceListener(deps, {
    onVoiceInput: ({ transcript, latencyMs, sttModel, audioDurationMs }) => {
      channels.publish(buildVoiceInputPayload(transcript, latencyMs, sttModel, audioDurationMs));
    },
    onSafetyPhrase: ({ matchedPhrase, transcript, latencyMs, audioDurationMs }) => {
      void runSafetyFastPath(channels, safety, {
        matchedPhrase,
        transcript,
        sttModel: startArgs.sttModel,
        latencyMs,
        audioDurationMs,
      });
    },
    onError: (err) => {
      channels.publish({
        meta: {
          source: 'voltras',
          event_type: 'voice_input_failed',
          error_code: err.code,
        },
        content: JSON.stringify({
          summary: `Voice listener error: ${err.message}`,
          error_code: err.code,
          message: err.message,
        }),
      });
    },
  });
  // Installed before start() resolves: arming takes ~530 ms now, and a
  // listen_stop landing inside that window has to be able to reach this
  // listener and release its mic-readiness wait.
  state.voice.listener = listener;
  try {
    await listener.start(startArgs);
  } catch (err) {
    state.voice.listener = null;
    return errorResult({
      code: 'LISTENER_START_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  // A listen_stop that raced this arm already tore it down and wins; saying
  // `listening` here would hand back a mic that is off.
  if (listener.getState() === 'idle') return textResult({ status: 'stopped' });
  return textResult({
    status: 'listening',
    wakePhrases: startArgs.wakePhrases,
    sttModel: startArgs.sttModel,
    micReady: listener.isMicLive(),
  });
}

async function stopListener(state: VoiceToolState): Promise<ToolResult> {
  // Stop the still-arming listener first — that releases its mic-readiness
  // wait instead of parking on the bound — then join the arm so it can never
  // complete behind us and leave a hot mic.
  const arming = state.voice.starting;
  if (arming !== null) {
    await state.voice.listener?.stop();
    await arming;
  }
  const listener = state.voice.listener;
  if (listener === null) {
    return textResult({ status: 'stopped' });
  }
  await listener.stop();
  state.voice.listener = null;
  return textResult({ status: 'stopped' });
}

/**
 * Build production deps. All native loads (sox mic, onnxruntime VAD, whisper)
 * are lazy inside their factories, so this never fails synchronously — a
 * missing install surfaces as `LISTENER_START_FAILED` at start() time.
 */
function buildProductionDeps(): VoiceListenerDeps {
  const whisper = defaultWhisper();
  return {
    audioFactory: defaultAudioFactory,
    vadFactory: defaultVadFactory,
    whisper,
    prewarm: defaultPrewarm(whisper),
  };
}
