// `system.listen_start` / `system.listen_stop` — voice input MVP.
//
// The listener wires an openWakeWord Python sidecar (see
// voltras-mcp/voice-listener/) to the local mic via `node-record-lpcm16`,
// then transcribes post-wake utterances with `nodejs-whisper`. Transcripts
// land on the channel publisher as `voice_input` events; `wake_word_detected`
// fires the moment the sidecar reports a wake so PT Claude can respond
// "I'm listening" before STT finishes.
//
// Off-by-default: nothing happens at server boot. The user (or PT Claude)
// must call `system.listen_start` to arm the mic. `listen_stop` is
// idempotent — re-callable from a Stop button without race risk.
//
// Configuration knobs surface through the schema (wake word, model path,
// STT variant, max utterance duration). Environment-variable overrides for
// the Python interpreter + sidecar script path live in `voice-config.ts`.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SystemListenStartInput,
  SystemListenStopInput,
  type SystemListenStartInputType,
} from '../schemas/voice.js';
import { buildVoiceInputPayload, buildWakeWordDetectedPayload } from '../state/channel-payloads.js';
import type { ChannelPublisher } from '../state/channel-publisher.js';
import {
  defaultAudioFactory,
  defaultSidecarFactory,
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
  'Arm the local voice listener. Spawns the openWakeWord Python sidecar +',
  'mic capture; transcribes post-wake utterances locally via whisper.cpp.',
  'No audio leaves the machine. Default wake word: `hey_jarvis` (the',
  'closest 2-word built-in to the preferred `hey coach`; swap to a custom',
  'model by passing `wakeWordModelPath`). Default STT: `base.en` (~1s p50',
  'on Apple Silicon). Idempotent — re-arming returns the current state.',
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
      wakeWord: state.voice.listener.getStartArgs()?.wakeWord ?? startArgs.wakeWord,
      sttModel: state.voice.listener.getStartArgs()?.sttModel ?? startArgs.sttModel,
    });
  }
  const deps = state.voice.__deps !== null ? state.voice.__deps : buildProductionDeps();
  if (deps === null) {
    return errorResult({
      code: 'VOICE_DEPS_MISSING',
      message:
        'Voice deps unavailable: install Python ≥3.10 + voice-listener/requirements.txt and `brew install sox`.',
    });
  }
  const channels = state.channels;
  const listener = new VoiceListener(deps, {
    onWakeWord: ({ wakeWord, confidence, capturedAtMs }) => {
      channels.publish(buildWakeWordDetectedPayload(wakeWord, confidence, capturedAtMs));
    },
    onVoiceInput: ({ transcript, latencyMs, sttModel, audioDurationMs }) => {
      channels.publish(buildVoiceInputPayload(transcript, latencyMs, sttModel, audioDurationMs));
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
    wakeWord: startArgs.wakeWord,
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
 * Build production deps if all the prerequisites are in place. Returns null
 * when the Python sidecar script can't be located — the listener will
 * report this as `VOICE_DEPS_MISSING` rather than crashing.
 */
function buildProductionDeps(): VoiceListenerDeps | null {
  const scriptPath = resolveSidecarScript();
  if (scriptPath === null) return null;
  const pythonBin = process.env.VOLTRAS_VOICE_PYTHON ?? 'python3';
  return {
    audioFactory: defaultAudioFactory,
    sidecarFactory: defaultSidecarFactory(pythonBin, scriptPath),
    whisper: defaultWhisper(),
  };
}

/**
 * Find `voice-listener/listener.py` relative to the package root. Walk up
 * from this module's directory; package layout is `dist/tools/...` after
 * build and `src/tools/...` in dev — both reach the repo root within 4
 * parents. Falls back to the env override for unusual layouts.
 */
export function resolveSidecarScript(): string | null {
  const override = process.env.VOLTRAS_VOICE_SIDECAR;
  if (override !== undefined && existsSync(override)) {
    return resolve(override);
  }
  const here = fileURLToPath(import.meta.url);
  let dir = dirname(here);
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'voice-listener', 'listener.py');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
