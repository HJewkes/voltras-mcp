// Wave 3D — `exercise.search`, `exercise.get`, `exercise.confirm_setup` and
// the VW-361 chapter pair (`exercise.mark_new_chapter` /
// `exercise.retire_chapter`) tool registrations.
//
// The first two are pure pass-throughs to the `ExerciseService` (R22 / AC-22):
// the wave-2B service owns the upstream catalog seam (`searchExercises`,
// `getExerciseById`), so this module never touches `@voltras/workout-analytics`
// directly. Search forwards `query` verbatim; get translates a missing entry
// into a structured `NOT_FOUND` error rather than letting `undefined` leak
// through as a `null` text payload.
//
// Registration mechanics: the server boots with `STARTING`-returning
// placeholders pre-registered for every tool name (see `src/server.ts`).
// Wave 3 hot-swaps the real callback in via `RegisteredTool.update({...})`;
// this preserves the original `RegisteredTool` reference, lets every tool
// register concurrently without ordering against `tools/list` notifications,
// and avoids the missing-tool window between `remove()` and a fresh
// `server.tool(...)` call. `server` is accepted in the signature for
// consistency with the wave-3 register-fn convention but is not currently
// used here — every callback attaches via the placeholder.
//
// Why `exercise.get` does not use `wrapHandler`: `wrapHandler` always frames
// the inner function's return value via `textResult`, which is right for the
// success path but would double-wrap a `NOT_FOUND` `errorResult`. We re-use
// the same pieces — `safeParse` for INVALID_INPUT, `mapSdkError` via try/catch
// — but compose them inline so `getById === undefined` can return the error
// result directly. `exercise.confirm_setup` composes the same way, for the
// same reason.
//
// `exercise.confirm_setup` is the odd one out in this module: it writes, and
// what it writes is the one thing the ROM clustering in
// `store/exercise-setups.ts` cannot derive — what a physical setup actually IS
// (VW-119).
//
// The chapter pair writes for the same kind of reason: only a human knows a
// technique reform happened, and every PR read clamps to what they declare
// (`store/exercise-chapters.ts`). There is no detector here and there is not
// meant to be one.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { mapSdkError } from '../errors.js';
import {
  ExerciseConfirmSetupInput,
  ExerciseGetInput,
  ExerciseMarkNewChapterInput,
  ExerciseRetireChapterInput,
  ExerciseSearchInput,
} from '../schemas/exercise.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID, type SetupCard, type StoredExerciseSetup } from '../store/types.js';
import { errorResult, textResult, wrapHandler, type ToolResult } from './helpers.js';

/**
 * Swap real handlers for `exercise.search` and `exercise.get` into their
 * `STARTING` placeholders. Idempotent against the placeholder Map: if a
 * placeholder is missing the entry is skipped, which keeps the function safe
 * to call after `mock` placeholder cleanup in `runServer`.
 */
export function registerExerciseTools(
  _server: McpServer,
  state: ServerState,
  placeholders: Map<string, RegisteredTool>,
): void {
  const search = wrapHandler(ExerciseSearchInput, async ({ query }) => {
    return state.exercises.search(query);
  });
  placeholders.get('exercise.search')?.update({
    paramsSchema: ExerciseSearchInput.shape,
    callback: search as never,
    description:
      'Search the exercise catalog by free-text query (name/aliases). Returns matching ' +
      'exercises with their catalog ids — use the returned `id` for `exercise.get` or any ' +
      'other tool that takes an `exerciseId`. Empty query behavior depends on the catalog ' +
      'service; pass a specific term rather than relying on it to list everything.',
  } as never);

  placeholders.get('exercise.get')?.update({
    paramsSchema: ExerciseGetInput.shape,
    callback: makeGetCallback(state) as never,
    description:
      'Look up one exercise by its catalog id. Returns NOT_FOUND if the id does not exist — ' +
      'use `exercise.search` first if you only have a name, not an id.',
  } as never);

  placeholders.get('exercise.confirm_setup')?.update({
    paramsSchema: ExerciseConfirmSetupInput.shape,
    callback: makeConfirmSetupCallback(state) as never,
    description: CONFIRM_SETUP_DESCRIPTION,
  } as never);

  const markNewChapter = wrapHandler(ExerciseMarkNewChapterInput, async (input) => {
    const now = new Date().toISOString();
    return state.store.markExerciseChapter({
      userId: LOCAL_USER_ID,
      exerciseId: input.exerciseId,
      startedAt: input.startedAt ?? now,
      declaredAt: now,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
  });
  placeholders.get('exercise.mark_new_chapter')?.update({
    paramsSchema: ExerciseMarkNewChapterInput.shape,
    callback: markNewChapter as never,
    description: MARK_NEW_CHAPTER_DESCRIPTION,
  } as never);

  placeholders.get('exercise.retire_chapter')?.update({
    paramsSchema: ExerciseRetireChapterInput.shape,
    callback: makeRetireChapterCallback(state) as never,
    description: RETIRE_CHAPTER_DESCRIPTION,
  } as never);
}

const MARK_NEW_CHAPTER_DESCRIPTION =
  'Declare that this exercise starts a new chapter (VW-361) — the point after which the ' +
  "loads before it stop being the number to beat. Clamps this exercise's e1RM PR check, " +
  '`history.trend` and `progression.get_for_exercise` to `startedAt`, so a pre-chapter best ' +
  'can no longer win. Nothing is deleted, hidden or recomputed: the older sets stay exactly ' +
  'where they are and `exercise.retire_chapter` undoes the declaration. ' +
  'MANUAL ONLY, NEVER INFERRED. Do not call this because a number dropped, a set looked ' +
  'ragged or a layoff ended — nothing here can tell a technique reform from a bad week, and a ' +
  'wrong call silently erases PR history the lifter earned. Call it when the lifter (or their ' +
  'coach) says the movement itself changed: a reformed squat depth, a new grip, a corrected ' +
  'bar path. `startedAt` defaults to now and may be backdated to when the reform began; ' +
  "`reason` is the lifter's own words. The framing is RP's own — pre-reform PRs \"don't " +
  'count" because they were set with the faulty technique, and beating them later is a bonus, ' +
  'not the goal (rp:rp-s3-old-prs-irrelevant-reframe).';

const RETIRE_CHAPTER_DESCRIPTION =
  'Undo a chapter declared by `exercise.mark_new_chapter` (VW-361), by the `id` that call ' +
  "returned. The exercise's full history becomes comparable again immediately, because the " +
  'chapter only ever clamped a window — no set, rep or baseline was changed when it was ' +
  'declared, so none needs restoring now. The row itself is kept and marked retired rather ' +
  'than deleted: that the lifter once declared a reform is history too. NOT_FOUND if no ' +
  'chapter carries that id (rp:rp-s3-old-prs-irrelevant-reframe).';

const CONFIRM_SETUP_DESCRIPTION =
  'Name an inferred physical setup (VW-119) — the bench height, attachment or stance a group ' +
  'of sets was performed at — and mark it confirmed. `setupId` comes from a ' +
  '`baselines.recalc { inferSetups: true }` response; NOT_FOUND if no such setup exists. ' +
  "THE LABEL MUST BE THE USER'S OWN ANSWER. The clustering can tell that two groups of sets " +
  'moved the cable different distances; it cannot tell what the difference was, which is the ' +
  'entire reason this tool exists. Ask, then record what they say. Do not infer a label from ' +
  'the range of motion, the exercise name or the weight, and do not offer a guess for them to ' +
  'confirm — a plausible wrong name is worse than "setup 1", because it reads as a measurement. ' +
  "Optional `card` (VW-275) records the rig's declared configuration: `anchor` " +
  '(low/mid/chest/high — a landmark, never a measurement, because no numeric anchor height is ' +
  'published for the device), `mountHole` (the rack hole index, when the mount indexes to one), ' +
  "`cableLengthSetting` (the device's Settings > Cable length value, exactly as shown on its " +
  'screen), and `mode` (the resistance mode by its on-device menu name). Same rule as `label`: ' +
  'these are the answers the lifter gives, never a guess offered for confirmation. The wall ' +
  "shows this exercise's most recently confirmed card at exercise start, and a later session " +
  'whose own card disagrees with it is flagged rather than silently compared.';

/**
 * Build the `exercise.get` callback. Cannot use `wrapHandler` because the
 * `undefined` return from `getById` must become a `NOT_FOUND` `ToolResult`,
 * not a `textResult(undefined)`.
 */
function makeGetCallback(
  state: ServerState,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = ExerciseGetInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    try {
      const exercise = state.exercises.getById(parsed.data.id);
      if (exercise === undefined) {
        return errorResult({
          code: 'NOT_FOUND',
          message: `Exercise not found: ${parsed.data.id}`,
        });
      }
      return textResult(exercise);
    } catch (err) {
      return errorResult(mapSdkError(err));
    }
  };
}

/**
 * Build the `exercise.confirm_setup` callback. Same inline composition as
 * `exercise.get`, and for the same reason: an unknown `setupId` must become a
 * `NOT_FOUND` result rather than a success carrying `undefined`.
 *
 * This is the ONLY writer of `confirmed_at` and of a non-generated label. The
 * clustering derives which sets belong together and stops there; what the
 * grouping physically IS only a human knows, and re-inference carries both
 * fields forward untouched.
 */
function makeConfirmSetupCallback(
  state: ServerState,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = ExerciseConfirmSetupInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    try {
      return textResult(await confirmSetup(state, parsed.data));
    } catch (err) {
      return err instanceof SetupNotFound
        ? errorResult({ code: 'NOT_FOUND', message: err.message })
        : errorResult(mapSdkError(err));
    }
  };
}

/** Signals an unknown `setupId` so the callback can map it to `NOT_FOUND`. */
class SetupNotFound extends Error {}

async function confirmSetup(
  state: ServerState,
  input: z.infer<typeof ExerciseConfirmSetupInput>,
): Promise<StoredExerciseSetup> {
  const existing = await state.store.getExerciseSetup(input.setupId);
  if (existing === undefined) {
    throw new SetupNotFound(
      `Setup not found: ${input.setupId}. Ids come from baselines.recalc { inferSetups: true }.`,
    );
  }
  const confirmed: StoredExerciseSetup = {
    ...existing,
    label: input.label,
    confirmedAt: new Date().toISOString(),
    ...(input.card !== undefined ? { card: cleanSetupCard(input.card) } : {}),
  };
  await state.store.putExerciseSetup(confirmed);
  return confirmed;
}

/**
 * Build the `exercise.retire_chapter` callback. Inline rather than via
 * `wrapHandler` for the same reason as `exercise.get`: an unknown `chapterId`
 * must surface as `NOT_FOUND`, not as a success carrying `undefined`.
 */
function makeRetireChapterCallback(
  state: ServerState,
): (args: unknown, extra?: unknown) => Promise<ToolResult> {
  return async (args: unknown, _extra?: unknown): Promise<ToolResult> => {
    const parsed = ExerciseRetireChapterInput.safeParse(args);
    if (!parsed.success) {
      return errorResult({ code: 'INVALID_INPUT', message: parsed.error.message });
    }
    try {
      const retired = await state.store.retireExerciseChapter(
        parsed.data.chapterId,
        new Date().toISOString(),
      );
      return retired === undefined
        ? errorResult({
            code: 'NOT_FOUND',
            message: `Chapter not found: ${parsed.data.chapterId}. Ids come from exercise.mark_new_chapter.`,
          })
        : textResult(retired);
    } catch (err) {
      return errorResult(mapSdkError(err));
    }
  };
}

/**
 * Zod leaves an unset optional field as `undefined` rather than absent, which
 * `exactOptionalPropertyTypes` treats as a distinct (disallowed) value for
 * {@link StoredExerciseSetup}'s optional fields. Rebuild the card with only
 * the keys actually given.
 */
function cleanSetupCard(
  card: NonNullable<z.infer<typeof ExerciseConfirmSetupInput>['card']>,
): SetupCard {
  return {
    anchor: card.anchor,
    ...(card.mountHole !== undefined ? { mountHole: card.mountHole } : {}),
    ...(card.cableLengthSetting !== undefined
      ? { cableLengthSetting: card.cableLengthSetting }
      : {}),
    ...(card.mode !== undefined ? { mode: card.mode } : {}),
  };
}
