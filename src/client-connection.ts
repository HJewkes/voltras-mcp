// One MCP client connection, over the shared `ServerState` (VMCP-01.60).
//
// Today exactly one connection exists: `runServer` creates it and binds it to
// stdio. The point of this module is that nothing here assumes that. Every
// per-connection artifact — the `McpServer`, its placeholder map, its channel
// publisher, its resource registrations — lives on the returned handle rather
// than in `runServer`'s scope, so VMCP-01.62 can construct one of these per
// socket accepted by the daemon without touching the tool layer.
//
// That works because `ServerState` is threaded BY REFERENCE into every
// `register*Tools(server, state, placeholders)` call: N servers over one state
// is already the shape the tool layer is written against.
//
// STILL SINGULAR (deliberately out of scope here, see VMCP-01.63): the
// `state.channels` publisher and the `state.server` handle are single fields on
// `ServerState`, so with two connections the last `activate()` would win. This
// module does not touch them — `runServer` still owns that wiring, and the
// fan-out rework is P3's job. Do not "fix" it by assigning them from
// `activate()`; that would silently make the second connection steal channel
// delivery from the first.

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { McpChannelPublisher, noopChannelPublisher } from './state/channel-publisher.js';
import { errorResult, type ToolResult } from './tools/helpers.js';
import { CORE_TOOL_NAMES, MOCK_TOOL_NAMES } from './tool-registry.js';
import { isDeviceEngaged, type ServerState } from './state/server-state.js';

import { registerDeviceTools, unloadSlot, isSafetyUnloadWarranted } from './tools/device-tools.js';
import { registerSessionTools } from './tools/session-tools.js';
import { registerSetTools } from './tools/set-tools.js';
import { registerMetricsTools } from './tools/metrics-tools.js';
import { registerExerciseTools } from './tools/exercise-tools.js';
import { registerMockTools } from './tools/mock-tools.js';
import { registerTimerTools } from './tools/timer-tools.js';
import { registerServerTools } from './tools/server-tools.js';
import { registerDebugTools } from './tools/debug-tools.js';
import { registerSystemTools, speak, type SpeakDeps } from './tools/tts-tools.js';
import { registerVoiceTools, type VoiceSafetyContext } from './tools/voice-tools.js';
import { registerSlotTools } from './tools/slot-tools.js';
import { registerProgressionTools } from './tools/progression-tools.js';
import { registerIsometricTools } from './tools/isometric-tools.js';
import { registerPlanTools } from './tools/plan-tools.js';
import { registerLeaseTools } from './tools/lease-tools.js';
import { applyLeaseGuard } from './lease-guard.js';
import { surrenderDevice } from './tools/device-surrender.js';
import { log } from './logger.js';
import { registerDeviceResource } from './resources/device-resource.js';
import { registerSessionResource } from './resources/session-resource.js';
import { registerSetResource } from './resources/set-resource.js';

/**
 * Identity of a single connected MCP client. Opaque and process-local: it
 * exists so shared state can be attributed to a caller (which tool call came
 * from whom), which is the prerequisite for the write-lease in VMCP-01.61.
 * Before this, `src/` scoped state to `slotId` only and had no notion of a
 * caller at all.
 */
export type ClientId = string;

let clientSeq = 0;

/** Mint the next client id. Monotonic within a process; not persisted. */
export function mintClientId(): ClientId {
  clientSeq += 1;
  return `client-${clientSeq}`;
}

/**
 * Reset the id counter. Test-only — keeps ids stable across test cases. The
 * `__` prefix follows the repo's convention for test seams exported from
 * production modules (cf. `__resetSessionRecorder`).
 */
export function __resetClientIdSequence(): void {
  clientSeq = 0;
}

/**
 * A single client's view of the server: its own protocol handle and tool
 * registrations, sharing the one process-wide `ServerState`.
 */
export interface ClientConnection {
  readonly clientId: ClientId;
  readonly server: McpServer;
  /** Placeholder handles, hot-swapped to real handlers by {@link activate}. */
  readonly placeholders: Map<string, RegisteredTool>;
  /** This connection's channel publisher, bound to its own `McpServer`. */
  readonly channels: McpChannelPublisher;
  /**
   * Swap the `STARTING` placeholders for real handlers bound to `state`.
   * Idempotent per connection is NOT guaranteed — call exactly once, after
   * bootstrap resolves.
   */
  activate(state: ServerState): void;
  /**
   * Tear this connection down: unregister it and close its `McpServer`.
   *
   * At N=1 behind `process.exit` this is nearly ceremonial, but the daemon
   * (VMCP-01.62) drops a connection per closed socket, and each one owns an
   * `McpServer`, an ~80-entry `RegisteredTool` map, three resource
   * registrations and an `McpChannelPublisher` that keeps a dead transport
   * reachable from shared state. Leaking those per socket is a real leak, so
   * the seam exists from the start rather than being retrofitted.
   */
  close(state: ServerState): Promise<void>;
}

/**
 * Register a connection against the shared state.
 *
 * Rejects a duplicate `clientId` rather than overwriting: a silent overwrite
 * leaves the displaced connection alive and serving tool calls while untracked
 * by everything that reasons about `state.clients` (the write-lease, for one).
 * Reachable today only by mixing explicit ids with minted ones — the daemon
 * keys by socket — but the failure is invisible, so it fails loud instead.
 */
export function registerClient(state: ServerState, connection: ClientConnection): void {
  if (state.clients.has(connection.clientId)) {
    throw new Error(`duplicate clientId: ${connection.clientId}`);
  }
  state.clients.set(connection.clientId, connection);
}

/**
 * Permissive placeholder schema. Without a paramsSchema the SDK invokes the
 * handler with only `extra` (no `args`), which would silently drop every tool
 * argument once the real handlers are swapped in. Each real handler's
 * `wrapHandler(schema, fn)` does the actual typed validation.
 */
const PLACEHOLDER_SCHEMA = z.object({}).passthrough().shape;

/** Single shared `STARTING` response — returned by every placeholder. */
function startingResult(): ToolResult {
  return errorResult({
    code: 'STARTING',
    message: 'Server is initializing — try again in a moment.',
  });
}

/**
 * Register a `STARTING`-returning placeholder for every tool name (R6/EC-16),
 * so a tool call arriving during the bootstrap window returns a structured
 * error rather than a missing-tool error.
 */
function registerStartingPlaceholders(server: McpServer): Map<string, RegisteredTool> {
  const placeholders = new Map<string, RegisteredTool>();
  const callback = (): ToolResult => startingResult();
  for (const name of [...CORE_TOOL_NAMES, ...MOCK_TOOL_NAMES]) {
    placeholders.set(name, server.tool(name, PLACEHOLDER_SCHEMA, callback));
  }
  return placeholders;
}

/**
 * Tier-A ungated safety fast-path (VMCP-02.78). The voice listener calls into
 * this when it hears a stop phrase, unloading the cable directly with no LLM
 * round-trip. Shares the state's voice-listener ref so the "stopping" ack ducks
 * the mic.
 */
function makeVoiceSafety(state: ServerState): VoiceSafetyContext {
  return {
    evaluate: (slotId) => {
      const verdict = isSafetyUnloadWarranted(state, slotId);
      const setId = state.slots.get(slotId)?.live.snapshotSet()?.setId ?? null;
      return { warranted: verdict.warranted, reason: verdict.reason, setId };
    },
    unload: (slotId) => unloadSlot(state, slotId),
    speakAck: (text) => {
      const deps: SpeakDeps = {
        platform: process.platform,
        spawn: spawn as SpeakDeps['spawn'],
        voiceListenerRef: state.voice,
      };
      void speak({ text, interrupt: true, blocking: false }, deps).catch(() => {
        // Best-effort ack — never let a failed cue affect the unload.
      });
    },
  };
}

/**
 * Hot-swap every placeholder for its real handler. Mock-only tools never have
 * real handlers in node mode, so their placeholders are dropped instead —
 * `tools/list` then reflects only the real surface (R11).
 */
function registerRealTools(
  server: McpServer,
  state: ServerState,
  placeholders: Map<string, RegisteredTool>,
  self: ClientId,
): void {
  if (state.config.adapter !== 'mock') {
    for (const name of MOCK_TOOL_NAMES) {
      placeholders.get(name)?.remove();
      placeholders.delete(name);
    }
  }
  registerDeviceTools(server, state, placeholders);
  registerSessionTools(server, state, placeholders);
  registerSetTools(server, state, placeholders);
  registerMetricsTools(server, state, placeholders);
  registerExerciseTools(server, state, placeholders);
  registerTimerTools(server, state, placeholders);
  registerServerTools(server, state, placeholders);
  registerDebugTools(server, state, placeholders);
  registerSystemTools(server, placeholders, undefined, state.voice);
  registerVoiceTools(server, state, placeholders, makeVoiceSafety(state));
  registerSlotTools(server, state, placeholders);
  registerProgressionTools(server, state, placeholders);
  registerIsometricTools(server, state, placeholders);
  registerPlanTools(server, state, placeholders);
  registerLeaseTools(server, state, placeholders, self);
  if (state.config.adapter === 'mock') {
    registerMockTools(server, state, placeholders);
  }
  // LAST: the guard wraps whatever handler is installed, so it must run after
  // every registration above. Wrapping earlier would gate a placeholder's
  // `STARTING` response instead of the real work.
  applyLeaseGuard(placeholders, state, self);
}

/**
 * Build a client connection: an `McpServer` with placeholder tools and
 * resources registered, ready for `server.connect(transport)`.
 *
 * Resources are registered here, BEFORE the caller connects a transport,
 * because `registerResource` extends server capabilities and the SDK forbids
 * that after connect. They read through a lazy box that {@link
 * ClientConnection.activate} fills, so their callbacks resolve against live
 * state once bootstrap completes. The box enumerates slots at read time, so
 * bilateral flows that allocate `'left'`/`'right'` after bootstrap surface in
 * the resource list automatically.
 */
export function createClientConnection(clientId: ClientId = mintClientId()): ClientConnection {
  const server = new McpServer(
    { name: 'voltras-mcp', version: '0.1.0' },
    {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        // Experimental: declares support for `claude/channel` push events so
        // hosts that opt in route our notifications/claude/channel messages
        // back to the model inline as <channel> tags. Hosts without channel
        // support silently ignore the declaration. See
        // state/channel-publisher.ts for delivery semantics.
        experimental: { 'claude/channel': {} },
      },
    },
  );
  const channels = new McpChannelPublisher(server);
  const placeholders = registerStartingPlaceholders(server);

  const stateBox: { value?: ServerState } = {};
  const lazyState = {
    liveForSlot: (slotId: string) => stateBox.value?.slots.get(slotId)?.live,
    slotIds: () => (stateBox.value ? [...stateBox.value.slots.keys()] : []),
    repSource: () => stateBox.value?.config.repSource ?? 'analytics',
  };
  registerDeviceResource(server, lazyState);
  registerSessionResource(server, lazyState);
  registerSetResource(server, lazyState);

  return {
    clientId,
    server,
    placeholders,
    channels,
    activate(state: ServerState): void {
      stateBox.value = state;
      registerRealTools(server, state, placeholders, clientId);
    },
    async close(state: ServerState): Promise<void> {
      // A departed client cannot drive the device, so its lease must not strand
      // the hardware until the idle timeout. But releasing alone would hand the
      // NEXT client a still-loaded cable, which is the same hazard a forced
      // steal guards against — so surrender first when this client was driving.
      //
      // stdio pipes drop routinely here: VMCP-01.25 (F11) documents Claude Code
      // abandoning the pipe on reconnect rather than closing it. So this is the
      // ordinary path, not an exotic one, and surrendering also PERSISTS the
      // in-flight set that would otherwise be lost.
      if (state.lease.isHeldBy(clientId) && isDeviceEngaged(state)) {
        // Freeze first, as the steal and release paths do: a departing client
        // can still have an in-flight write tool that would re-engage the motor
        // while we are unloading.
        //
        // If another client is ALREADY mid-handover it is surrendering the
        // device for us, so we neither surrender nor touch the freeze. Calling
        // abortTransfer() unconditionally here would unfreeze THEIR transfer
        // mid-surrender and reopen the window this exists to close.
        let frozenByUs = false;
        try {
          state.lease.beginTransfer();
          frozenByUs = true;
        } catch {
          frozenByUs = false;
        }
        if (frozenByUs) {
          try {
            await surrenderDevice(state);
          } catch (err) {
            log.error('failed to surrender the device on client disconnect', err);
          } finally {
            state.lease.abortTransfer();
          }
        }
      }
      state.lease.releaseOnDisconnect(clientId);
      state.clients.delete(clientId);
      // These two fields are process-wide but currently point at whichever
      // connection wired them (see wireProcessState). If that was US, clear them
      // rather than leave a dangling reference — otherwise the event bridge goes
      // on publishing into a closed McpServer. Fanning them out per client is
      // VMCP-01.63; this just stops close() making it worse.
      if (state.server === server) {
        delete state.server;
        state.channels = noopChannelPublisher;
      }
      // Drop the state reference so a closed connection's resource callbacks
      // cannot resolve against live state after teardown.
      delete stateBox.value;
      await server.close();
    },
  };
}
