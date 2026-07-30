// `profile.*` tool handlers — the training-background write/read path
// (VW-96 Wave 3).
//
// `training_profile` has existed as inert DDL since v6 (schema-only, no
// writer, deliberately cheap to add ahead of any consumer — see
// `sqlite-store.ts`). This module gives it its first read/write call sites.
//
// Storage only. These handlers capture the user's self-reported answers
// verbatim and hand them to the store; they never compute or infer a tier.
// Tier derivation is VW-92's job, against this table, with a different owner.
//
// `profile.set_training_background` merges each call onto the existing row
// (read-modify-write) rather than overwriting the whole row, because the
// design doc (tier-signal design, data-layer-migration-plan.md §6a) expects
// onboarding to ask its handful of questions across separate turns — a
// naive full-row `INSERT ... ON CONFLICT DO UPDATE` with unset fields bound
// to NULL would wipe out an earlier answer on every subsequent call.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import {
  ProfileGetTierSignalInput,
  ProfileGetTrainingBackgroundInput,
  ProfileSetTrainingBackgroundInput,
} from '../schemas/profile.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID, type StoredTrainingProfile } from '../store/types.js';
import { wrapHandler } from './helpers.js';
import { getTierSignal, type TierSignal } from './tier-signal.js';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

/**
 * Hot-swap the `profile.*` placeholders with their real handlers. Mirrors the
 * install pattern used by the other tool registries (see `plan-tools.ts`).
 */
export function registerProfileTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'profile.set_training_background',
    ProfileSetTrainingBackgroundInput,
    wrapHandler(ProfileSetTrainingBackgroundInput, (input) => setTrainingBackground(state, input)),
  );
  install(
    placeholders,
    'profile.get_training_background',
    ProfileGetTrainingBackgroundInput,
    wrapHandler(ProfileGetTrainingBackgroundInput, () => getTrainingBackground(state)),
  );
  install(
    placeholders,
    'profile.get_tier_signal',
    ProfileGetTierSignalInput,
    wrapHandler(ProfileGetTierSignalInput, () => getTierSignalTool(state)),
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  tool.update({ paramsSchema: schema.shape, callback: callback as never });
}

/**
 * Merge the caller-supplied fields onto the existing `training_profile` row
 * (or start a fresh one), stamp per-field provenance as `'user'` for whatever
 * was just supplied, and upsert. `declaredAt`/`goalSetAt` are refreshed only
 * when the corresponding value changes this call; `onboardedAt` is stamped
 * once, the first time any field is written.
 */
async function setTrainingBackground(
  state: ServerState,
  input: z.infer<typeof ProfileSetTrainingBackgroundInput>,
): Promise<{ profile: StoredTrainingProfile }> {
  const existing = await state.store.getTrainingProfile(LOCAL_USER_ID);
  const now = new Date().toISOString();
  const provenance: Record<string, 'user' | 'llm' | 'default'> = { ...existing?.provenance };

  const merged: StoredTrainingProfile = {
    ...existing,
    userId: LOCAL_USER_ID,
    onboardedAt: existing?.onboardedAt ?? now,
    updatedAt: now,
  };

  if (input.declaredTier !== undefined) {
    merged.declaredTier = input.declaredTier;
    merged.declaredAt = now;
    provenance.declaredTier = 'user';
  }
  if (input.yearsTraining !== undefined) {
    merged.yearsTraining = input.yearsTraining;
    provenance.yearsTraining = 'user';
  }
  if (input.historyConsistent !== undefined) {
    merged.historyConsistent = input.historyConsistent;
    provenance.historyConsistent = 'user';
  }
  if (input.everPlateaued !== undefined) {
    merged.everPlateaued = input.everPlateaued;
    provenance.everPlateaued = 'user';
  }
  if (input.reportedSetsPerMuscle !== undefined) {
    merged.reportedSetsPerMuscle = input.reportedSetsPerMuscle;
    provenance.reportedSetsPerMuscle = 'user';
  }
  if (input.goal !== undefined) {
    merged.goal = input.goal;
    merged.goalSetAt = now;
    provenance.goal = 'user';
  }
  if (input.daysAvailable !== undefined) {
    merged.daysAvailable = input.daysAvailable;
    provenance.daysAvailable = 'user';
  }
  if (input.daysReliable !== undefined) {
    merged.daysReliable = input.daysReliable;
    provenance.daysReliable = 'user';
  }
  if (Object.keys(provenance).length > 0) {
    merged.provenance = provenance;
  }

  await state.store.putTrainingProfile(merged);
  return { profile: merged };
}

async function getTrainingBackground(
  state: ServerState,
): Promise<{ profile: StoredTrainingProfile | null }> {
  const profile = await state.store.getTrainingProfile(LOCAL_USER_ID);
  return { profile: profile ?? null };
}

/**
 * `profile.get_tier_signal` (VW-92 MVP) — the crude ceiling only, see
 * `tier-signal.ts`. Read-only; derives nothing new here and writes nothing.
 */
async function getTierSignalTool(state: ServerState): Promise<{ tierSignal: TierSignal }> {
  const tierSignal = await getTierSignal(state, LOCAL_USER_ID);
  return { tierSignal };
}
