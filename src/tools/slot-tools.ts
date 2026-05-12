// `slot.*` tool registry — visual side-identification, slot utilities, and
// persistent deviceId ↔ physical-side bindings.
//
// `slot.identify` briefly switches the named slot's device into Damper mode
// (the device screen visibly changes) then reverts to its prior mode. This
// collapses the PT-skill's manual 4-call side-identification ritual into one
// call: the user watches which physical Voltra changes its display to confirm
// which slot it is bound to.
//
// `slot.bind` (VMCP-02.05) writes a deviceId ↔ physical_side mapping to
// `~/.voltras/slot-bindings.json` so subsequent sessions can skip the
// ritual: `device.connect {slot: 'auto'}` resolves the slot from the
// persisted binding when the deviceId is known.
//
// All BLE interaction flows through the slot's `client` — AC-14 forbids any
// direct BLE-adapter library references in this file.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TrainingMode } from '@voltras/node-sdk';
import { z } from 'zod';

import { SlotIdSchema } from '../schemas/common.js';
import { type ServerState, PRIMARY_SLOT, getSlot } from '../state/server-state.js';
import { wrapHandler, type ToolResult } from './helpers.js';

// ── Schema ────────────────────────────────────────────────────────────────

const DEFAULT_IDENTIFY_DURATION_MS = 3_000;
const MIN_IDENTIFY_DURATION_MS = 500;
const MAX_IDENTIFY_DURATION_MS = 10_000;

const SlotIdentifyInput = z.object({
  slot: SlotIdSchema,
  durationMs: z
    .number()
    .int()
    .min(MIN_IDENTIFY_DURATION_MS)
    .max(MAX_IDENTIFY_DURATION_MS)
    .optional()
    .default(DEFAULT_IDENTIFY_DURATION_MS),
});

// ── slot.bind schema (VMCP-02.05) ─────────────────────────────────────────
//
// `physicalSide` is the user-facing left/right label; the schema deliberately
// keeps the enum free of the bookkeeping slot ids (`primary`, etc.) — those
// are an MCP-internal concept, while `left`/`right` are what the user sees
// and reports to the model. The mapping from physicalSide → slotId for the
// auto-connect path lives in `device.connect`.
const SlotBindInput = z
  .object({
    deviceId: z.string().min(1),
    physicalSide: z.enum(['left', 'right']),
  })
  .strict();

const SlotBindingsListInput = z.object({}).strict();

const SlotUnbindInput = z
  .object({
    deviceId: z.string().min(1),
  })
  .strict();

// ── Placeholder-swap helper ────────────────────────────────────────────────

type Placeholders = Map<string, RegisteredTool>;

function install<S extends z.ZodObject>(
  placeholders: Placeholders,
  name: string,
  schema: S,
  handler: (args: unknown, extra?: unknown) => Promise<ToolResult>,
  description?: string,
): void {
  const reg = placeholders.get(name);
  if (reg === undefined) {
    console.warn(`registerSlotTools: no placeholder found for ${name}`);
    return;
  }
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: handler as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  reg.update(updates as never);
}

// ── Tool descriptions ─────────────────────────────────────────────────────

const IDENTIFY_DESCRIPTION =
  "Briefly switch the named slot's device into Damper mode (the device screen " +
  'changes visibly) then revert to its prior training mode. Use this to ' +
  'confirm which physical Voltra is bound to which slot — the user watches ' +
  "which device's display changes. Default hold: 3 s, configurable 500–10 000 ms. " +
  'Returns ALREADY_IN_DAMPER if the slot is already in Damper mode (no change ' +
  'made). Returns SLOT_NOT_BOUND if the slot is unknown.';

const SLOT_BIND_DESCRIPTION =
  'Persist a deviceId ↔ physical-side (left/right) mapping across MCP sessions. ' +
  'Write once after the user confirms the side via slot.identify; subsequent ' +
  "device.connect calls with slot: 'auto' will route the device to the same " +
  'side without re-running the ritual. Overwrites any existing binding for the ' +
  'same deviceId. Storage: ~/.voltras/slot-bindings.json.';

const SLOT_BINDINGS_LIST_DESCRIPTION =
  'List every persisted deviceId ↔ physical-side binding. Returns an array ' +
  'sorted by deviceId — useful for the PT skill to decide whether the side-ID ' +
  'ritual can be skipped for the currently-connected devices.';

const SLOT_UNBIND_DESCRIPTION =
  'Remove the persisted binding for `deviceId`. The next device.connect with ' +
  "slot: 'auto' against that device will fall back to the manual side-ID " +
  'ritual. Returns the removed binding, or null if the deviceId was unbound.';

// ── Private helpers ───────────────────────────────────────────────────────

function throwSdkLike(code: string, message: string): never {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  throw err;
}

/**
 * Resolve the training mode name from the SDK TrainingMode enum given a
 * numeric value. Falls back to the raw number's string form when the enum
 * has no reverse-mapping entry (e.g. for numeric-only values).
 */
function modeNameFromValue(value: number): string {
  const name = (TrainingMode as unknown as Record<number, string | undefined>)[value];
  return name ?? String(value);
}

// ── Registration ──────────────────────────────────────────────────────────

/**
 * Register all `slot.*` tools by hot-swapping their startup placeholders.
 * Mirrors the pattern used by `registerDeviceTools` and other tool modules.
 */
export function registerSlotTools(
  _server: McpServer,
  state: ServerState,
  placeholders: Placeholders,
): void {
  install(
    placeholders,
    'slot.identify',
    SlotIdentifyInput,
    wrapHandler(SlotIdentifyInput, async (input) => {
      const slotId = input.slot ?? PRIMARY_SLOT;
      const slot = getSlot(state, slotId);
      const client = slot.client;
      const durationMs = input.durationMs;

      // Confirm the slot is connected — getSlot doesn't guarantee connection.
      if (!client.isConnected) {
        throwSdkLike(
          'SLOT_NOT_BOUND',
          `Slot \`${slotId}\` is not connected. Connect a device first via device.connect.`,
        );
      }

      // Read current training mode from the live device snapshot.
      const snapshot = slot.live.snapshotDevice();
      const previousModeName = snapshot.trainingMode ?? 'Idle';

      const damperName = modeNameFromValue(TrainingMode.Damper);
      if (previousModeName === damperName) {
        throwSdkLike(
          'ALREADY_IN_DAMPER',
          `Slot \`${slotId}\` is already in Damper mode — no identification needed.`,
        );
      }

      // Switch to Damper.
      await client.setMode(TrainingMode.Damper);

      // Hold in Damper mode for the requested duration.
      await new Promise<void>((resolve) => setTimeout(resolve, durationMs));

      // Resolve the numeric value of the previous mode for revert call.
      const prevModeValue = (TrainingMode as unknown as Record<string, number | undefined>)[
        previousModeName
      ];
      if (prevModeValue === undefined) {
        // Unexpected — the mode name we got from the snapshot doesn't map
        // back to a numeric enum value. Return partial success with a warning.
        return {
          ok: true,
          slot: slotId,
          previousMode: previousModeName,
          identifiedFor: durationMs,
          revertWarning: `Could not map previous mode ${JSON.stringify(previousModeName)} back to a TrainingMode enum value — device remains in Damper mode. Use device.set_mode to restore.`,
        };
      }

      // Revert to previous mode.
      try {
        await client.setMode(prevModeValue as TrainingMode);
      } catch (revertErr) {
        const msg = revertErr instanceof Error ? revertErr.message : String(revertErr);
        // Log loudly — device is stuck in Damper and the user needs to know.
        console.error(
          `slot.identify: revert to ${previousModeName} failed for slot \`${slotId}\`: ${msg}`,
        );
        return {
          ok: true,
          slot: slotId,
          previousMode: previousModeName,
          identifiedFor: durationMs,
          revertWarning: `Revert to ${previousModeName} failed: ${msg}. The device is still in Damper mode — use device.set_mode to restore manually.`,
        };
      }

      return {
        ok: true,
        slot: slotId,
        previousMode: previousModeName,
        identifiedFor: durationMs,
      };
    }),
    IDENTIFY_DESCRIPTION,
  );

  // slot.bind (VMCP-02.05) — persist deviceId ↔ physical-side. Best paired
  // with slot.identify: once the user confirms which physical Voltra
  // changed its display, the model calls slot.bind to lock the mapping in
  // so the next session can skip the ritual entirely. No BLE I/O — pure
  // local state.
  install(
    placeholders,
    'slot.bind',
    SlotBindInput,
    wrapHandler(SlotBindInput, async (input) => {
      const binding = state.slotBindings.bind(input.deviceId, input.physicalSide);
      return { ok: true, binding };
    }),
    SLOT_BIND_DESCRIPTION,
  );

  install(
    placeholders,
    'slot.bindings_list',
    SlotBindingsListInput,
    wrapHandler(SlotBindingsListInput, async () => {
      return { bindings: state.slotBindings.list() };
    }),
    SLOT_BINDINGS_LIST_DESCRIPTION,
  );

  install(
    placeholders,
    'slot.unbind',
    SlotUnbindInput,
    wrapHandler(SlotUnbindInput, async (input) => {
      const removed = state.slotBindings.remove(input.deviceId);
      return { ok: true, removed };
    }),
    SLOT_UNBIND_DESCRIPTION,
  );
}
