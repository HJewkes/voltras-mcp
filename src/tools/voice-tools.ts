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
import { buildVoiceInputPayload } from '../state/channel-payloads.js';
import type { ChannelPublisher } from '../state/channel-publisher.js';
import {
  defaultAudioFactory,
  defaultVadFactory,
  defaultWhisper,
  resolveStartArgs,
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
  __deps: VoiceListenerDeps | null;
}

export function makeVoiceHolder(deps: VoiceListenerDeps | null = null): VoiceListenerHolder {
  return { listener: null, __deps: deps };
}

const START_DESCRIPTION = [
  'Arm the local voice listener. Runs an in-process Silero VAD + whisper.cpp',
  'over the mic — no audio leaves the machine, no wake-word model. Say the wake',
  'phrase (`hey coach`) to address the trainer; safety phrases (stop, unload,',
  'cut the weight, …) are always-on and need no wake phrase. Default STT:',
  '`tiny.en` (low latency). Idempotent — re-arming returns the current state.',
].join(' ');

const STOP_DESCRIPTION = [
  'Tear down the voice listener. Idempotent — calling on a stopped listener',
  'succeeds quietly. Safe to invoke from a Stop button.',
].join(' ');

export function registerVoiceTools(
  _server: McpServer,
  state: VoiceToolState,
  placeholders: PlaceholderTools,
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
    callback: makeStartCallback(state),
  });
  stopTool.update({
    description: STOP_DESCRIPTION,
    paramsSchema: SystemListenStopInput.shape,
    callback: makeStopCallback(state),
  });
}

function makeStartCallback(
  state: VoiceToolState,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = SystemListenStartInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    return startListener(state, parsed.data);
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
): Promise<ToolResult> {
  const startArgs = resolveStartArgs(input);
  if (state.voice.listener !== null) {
    return textResult({
      status: 'listening',
      wakePhrases: state.voice.listener.getStartArgs()?.wakePhrases ?? startArgs.wakePhrases,
      sttModel: state.voice.listener.getStartArgs()?.sttModel ?? startArgs.sttModel,
    });
  }
  const deps = state.voice.__deps !== null ? state.voice.__deps : buildProductionDeps();
  const channels = state.channels;
  const listener = new VoiceListener(deps, {
    onVoiceInput: ({ transcript, latencyMs, sttModel, audioDurationMs }) => {
      channels.publish(buildVoiceInputPayload(transcript, latencyMs, sttModel, audioDurationMs));
    },
    onSafetyPhrase: ({ transcript }) => {
      // VMCP-02.78: intercept here for the ungated unload fast-path (loaded+active
      // predicate + unloadSlot + deterministic_stop_triggered). For .77 a
      // recognized safety phrase still reaches the LLM as voice_input (no regression).
      channels.publish(buildVoiceInputPayload(transcript, 0, startArgs.sttModel, 0));
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
  try {
    await listener.start(startArgs);
  } catch (err) {
    return errorResult({
      code: 'LISTENER_START_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }
  state.voice.listener = listener;
  return textResult({
    status: 'listening',
    wakePhrases: startArgs.wakePhrases,
    sttModel: startArgs.sttModel,
  });
}

async function stopListener(state: VoiceToolState): Promise<ToolResult> {
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
  return {
    audioFactory: defaultAudioFactory,
    vadFactory: defaultVadFactory,
    whisper: defaultWhisper(),
  };
}
