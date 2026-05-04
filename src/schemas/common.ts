// Shared primitives reused by every schema in this directory.
//
// `IdSchema` is the canonical entity-id shape — every tool that accepts
// `setId`, `sessionId`, `id`, etc. composes from this so a single change here
// propagates to all schemas.
//
// `TrainingModeName` is the string form of the SDK's `TrainingMode` enum
// (e.g. `"WeightTraining"`). Schemas never expose the raw numeric enum value
// across the MCP boundary; handlers translate at the SDK seam.

import { z } from 'zod';

/** Non-empty string identifier used for sessions, sets, exercises, etc. */
export const IdSchema = z.string().min(1);

/** String form of the SDK's `TrainingMode` enum (never the raw number). */
export type TrainingModeName = string;
