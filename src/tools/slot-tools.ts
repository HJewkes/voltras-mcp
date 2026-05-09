// `slot.*` tool registry — visual side-identification and slot utilities.
//
// `slot.identify` briefly switches the named slot's device into Damper mode
// (the device screen visibly changes) then reverts to its prior mode. This
// collapses the PT-skill's manual 4-call side-identification ritual into one
// call: the user watches which physical Voltra changes its display to confirm
// which slot it is bound to.
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
        const msg =
          revertErr instanceof Error
            ? revertErr.message
            : String(revertErr);
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
}
