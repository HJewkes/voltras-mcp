// Shared primitives reused by every schema in this directory.
//
// `IdSchema` is the canonical entity-id shape — every tool that accepts
// `setId`, `sessionId`, `id`, etc. composes from this so a single change here
// propagates to all schemas.
//
// `TrainingModeName` is the string form of the SDK's `TrainingMode` enum
// (e.g. `"WeightTraining"`). Schemas never expose the raw numeric enum value
// across the MCP boundary; handlers translate at the SDK seam.
//
// `SlotIdSchema` is the optional dual-Voltras slot identifier threaded through
// every tool whose handler operates on slot-scoped state (device control, set
// lifecycle, session, mock). When omitted the handler resolves to the
// `'primary'` slot allocated at bootstrap, so single-device flows are
// unchanged. The description string is surfaced to LLM callers — keep it
// in sync with the dual-Voltras docs in `state/server-state.ts`.

import { z } from 'zod';

/** Non-empty string identifier used for sessions, sets, exercises, etc. */
export const IdSchema = z.string().min(1);

/** String form of the SDK's `TrainingMode` enum (never the raw number). */
export type TrainingModeName = string;

/**
 * Optional slot identifier for slot-scoped tools. Omit for single-device
 * sessions; the handler defaults to the `'primary'` slot. Description is
 * surfaced to MCP clients (and therefore to model callers).
 *
 * Step 3 of dual-Voltras support tightens the shape with a regex constraint
 * (`[a-zA-Z][a-zA-Z0-9_-]*`) so newly-allocated slot ids cannot contain
 * whitespace or punctuation that would mangle log lines, channel-meta tags,
 * or future routing keys. Existing single-device callers omit `slot`
 * entirely and remain unaffected.
 */
export const SlotIdSchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
  .optional()
  .describe(
    "Device slot identifier. Defaults to 'primary' for single-device sessions. Used to disambiguate when multiple devices are connected (e.g., 'left' / 'right' for bilateral exercises). Must match /^[a-zA-Z][a-zA-Z0-9_-]*$/ — letters, digits, underscores, and hyphens, leading with a letter.",
  );
