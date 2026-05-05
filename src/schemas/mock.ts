// Input schemas for `mock.*` tools (only registered when `VOLTRA_ADAPTER=mock`).
//
// SDK API inspection (node-sdk@0.3.0, dist/types/bluetooth/adapters/mock.d.ts):
//   `MockBLEAdapter` exposes a `MockBLEConfig` constructor argument with:
//     deviceName?, deviceId?, scanDelayMs?, connectDelayMs?,
//     weight?, repsPerSet?, restBetweenSetsMs?
//   It does NOT expose a public `configure()` method, nor any public
//   `injectError()` / error-injection surface.
//
// `MockConfigureInput` mirrors the constructor config fields. The Wave 3
// handler will need to either:
//   (a) recreate the `MockBLEAdapter` with the new config and re-bootstrap
//       the affected portions of `ServerState`, or
//   (b) wait for the SDK to expose a runtime `configure()` method and call
//       that.
// Choose (b) before merging if at all possible; (a) is intrusive and leaks
// adapter lifecycle into the tool layer.
//
// `MockInjectErrorInput` is defined per the briefing (5 error categories) but
// has NO matching SDK surface today. The Wave 3 handler MUST verify a public
// error-injection method exists on `MockBLEAdapter` before merging PR 3; if
// not, the tool should be removed from registration or the SDK extended.

import { z } from 'zod';

import { SlotIdSchema } from './common.js';

/**
 * Input for `mock.configure`. Fields mirror `MockBLEConfig` from
 * @voltras/node-sdk. All optional — partial updates are intended.
 */
export const MockConfigureInput = z.object({
  deviceName: z.string().optional(),
  deviceId: z.string().optional(),
  scanDelayMs: z.number().int().min(0).optional(),
  connectDelayMs: z.number().int().min(0).optional(),
  weight: z.number().int().min(0).optional(),
  repsPerSet: z.number().int().min(1).optional(),
  restBetweenSetsMs: z.number().int().min(0).optional(),
  slot: SlotIdSchema,
});

/**
 * Input for `mock.inject_error`. The five error categories below cover the
 * BLE lifecycle stages where injectable failures are useful for testing.
 *
 * NOTE: The public SDK does not currently expose an error-injection API on
 * `MockBLEAdapter`. Wave 3 handlers must verify the API exists before
 * registering this tool; see file header.
 */
export const MockInjectErrorInput = z.object({
  type: z.enum(['connection', 'scan', 'write', 'read', 'disconnect']),
  slot: SlotIdSchema,
});
