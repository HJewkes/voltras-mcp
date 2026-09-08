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
  startingPrescription,
  type StartingPrescription,
} from '../profile/starting-prescription.js';
import {
  ProfileGetStartingPrescriptionInput,
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
const SET_TRAINING_BACKGROUND_DESCRIPTION =
  "Record the user's self-reported onboarding/training-background answers: declaredTier, " +
  'yearsTraining, historyConsistent, everPlateaued (a real plateau event — the honest signal ' +
  'for graduating beginner->intermediate, more reliable than years trained or a physique ' +
  'read), reportedSetsPerMuscle, goal, daysAvailable (days per week they WANT), ' +
  'daysReliable (days per week they can DEFINITELY make — the number to actually program ' +
  'against, distinct from daysAvailable), currentBaseline (where they are NOW, free text), ' +
  'effortTolerance (low/moderate/high — how hard they are willing to be pushed) and target ' +
  '(where they want to END UP, free text). Those last three stay DISTINCT from each other ' +
  'and from goal on purpose: collapsing them is how intake ends up reading a target as a ' +
  'baseline. Call is a merge onto the existing row, not an ' +
  'overwrite — pass only the fields you have an answer for; earlier answers are preserved ' +
  'across multiple onboarding turns. This tool only stores verbatim self-report; it never ' +
  'infers or computes an experience tier (see profile.get_tier_signal for that).';

const GET_TRAINING_BACKGROUND_DESCRIPTION =
  'Read back the stored training-background/onboarding profile for the user. Returns ' +
  '`profile: null` if nothing has been captured yet.';

const GET_TIER_SIGNAL_DESCRIPTION =
  'Read a crude experience-tier signal (VW-92 MVP) derived from the stored training profile ' +
  '— a coarse ceiling, not a validated tier classification. Read-only; computes nothing new ' +
  'and writes nothing. Do not treat this as authoritative for tier-gated decisions without ' +
  'checking its `confidence`/`source` fields.';

const GET_STARTING_PRESCRIPTION_DESCRIPTION =
  'Seed a conservative starting point for a new lifter or a new exercise instead of ' +
  'inventing one: sessions/week, sets/exercise and an RIR target, keyed off the tier signal. ' +
  'Read-only — it writes nothing and applies nothing. Every seed is a SUGGESTION: offer it, ' +
  'accept or decline it with the lifter, and never re-apply it after a decline. RP seeds LOW ' +
  'on purpose — under-dosing week 1 is free to correct next week, while over-dosing leaves ' +
  'fatigue debt that carries forward — so do not "round up" these numbers to look ambitious. ' +
  '`assumesBeginner: true` means no tier was ever declared and the seeds are the default; ' +
  'say so out loud rather than presenting them as personalised. `setsPerExercise` may come ' +
  'back as the string `reported_minus_one`, which is an instruction to ASK the lifter what ' +
  'they currently run per muscle and seed one set below it — not a number to guess. ' +
  '`rirTarget: null` at the beginner tier is correct: beginners should not track RIR at all. ' +
  '`effortTolerance` moves only how aggressively the RIR note reads; it never changes a set ' +
  'count. `reasons[]` carries one line per seed — read them out, they are the argument.';

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
    SET_TRAINING_BACKGROUND_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.get_training_background',
    ProfileGetTrainingBackgroundInput,
    wrapHandler(ProfileGetTrainingBackgroundInput, () => getTrainingBackground(state)),
    GET_TRAINING_BACKGROUND_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.get_tier_signal',
    ProfileGetTierSignalInput,
    wrapHandler(ProfileGetTierSignalInput, () => getTierSignalTool(state)),
    GET_TIER_SIGNAL_DESCRIPTION,
  );
  install(
    placeholders,
    'profile.get_starting_prescription',
    ProfileGetStartingPrescriptionInput,
    wrapHandler(ProfileGetStartingPrescriptionInput, () => getStartingPrescription(state)),
    GET_STARTING_PRESCRIPTION_DESCRIPTION,
  );
}

function install<S extends z.ZodObject>(
  placeholders: PlaceholderTools,
  name: string,
  schema: S,
  callback: (args: unknown, extra?: unknown) => Promise<unknown>,
  description?: string,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) {
    throw new Error(`tool placeholder not registered: ${name}`);
  }
  const updates: Record<string, unknown> = {
    paramsSchema: schema.shape,
    callback: callback as never,
  };
  if (description !== undefined) {
    updates.description = description;
  }
  tool.update(updates as never);
}

/**
 * Every field that merges by simple copy. `declaredTier` and `goal` are absent
 * because each also refreshes its own timestamp, and `userId`/`onboardedAt`/
 * `updatedAt` are the handler's to set, never the caller's.
 */
const PLAIN_MERGE_FIELDS = [
  'yearsTraining',
  'historyConsistent',
  'everPlateaued',
  'reportedSetsPerMuscle',
  'daysAvailable',
  'daysReliable',
  'currentBaseline',
  'effortTolerance',
  'target',
] as const satisfies ReadonlyArray<keyof z.infer<typeof ProfileSetTrainingBackgroundInput>>;

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
  if (input.goal !== undefined) {
    merged.goal = input.goal;
    merged.goalSetAt = now;
    provenance.goal = 'user';
  }
  for (const field of PLAIN_MERGE_FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    Object.assign(merged, { [field]: value });
    provenance[field] = 'user';
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

/**
 * `profile.get_starting_prescription` (VMCP-06.04) — the tier signal and the
 * lifter's own reports, turned into a conservative seed. Read-only: the seeds
 * are returned for the agent to offer, and nothing here applies any of them.
 */
async function getStartingPrescription(
  state: ServerState,
): Promise<{ prescription: StartingPrescription }> {
  const { tier, confidence, source } = await getTierSignal(state, LOCAL_USER_ID);
  const profile = await state.store.getTrainingProfile(LOCAL_USER_ID);
  const prescription = startingPrescription({
    tier,
    confidence,
    source,
    ...(profile?.reportedSetsPerMuscle !== undefined
      ? { reportedSetsPerMuscle: profile.reportedSetsPerMuscle }
      : {}),
    ...(profile?.daysReliable !== undefined ? { daysReliable: profile.daysReliable } : {}),
    ...(profile?.effortTolerance !== undefined ? { effortTolerance: profile.effortTolerance } : {}),
  });
  return { prescription };
}
