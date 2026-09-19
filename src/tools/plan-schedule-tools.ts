// Dated blocks (VW-474): the `plan.*` tools that write and read a block's schedule.
//
// Every write appends complete snapshots to `block_schedules` (VW-473) and never edits one.
// The live row is a block's highest `seq`; `blockCalendar` turns it into dated weeks. Before
// any row is appended the whole proposal is checked, so a refused write leaves nothing behind:
// - I2: no two live calendars overlap, across every non-archived program;
// - I3: a current block's start never moves;
// - I6: a dated block's live `weeks_count` equals the block's own `weeksCount`;
// - I7: within a program, block order agrees with date order;
// - I8: an ended block gets no new row.
//
// There is no delete tool. `block_schedules` refuses to lose a block that has history (FK
// RESTRICT), and un-dating is `plan.block.schedule` with `startsOn: null`, which keeps it.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import { localDate, todayLocal } from '../analytics/training-days.js';
import {
  addDays,
  blockCalendar,
  isIsoDate,
  isMonday,
  planWeeksOf,
  scheduleRange,
  type BlockCalendar,
  type CalendarWeek,
} from '../plan/block-calendar.js';
import { mondaysAround, placementConflict, type PlacedBlock } from '../plan/block-placement.js';
import { scheduleHistory as historyOf, type ScheduleHistory } from '../plan/schedule-history.js';
import { lintMesoLengthGrewMidBlock, type PlanWarning } from '../plan/lint-plan.js';
import {
  PlanBlockCalendarInput,
  PlanBlockScheduleHistoryInput,
  PlanBlockScheduleInput,
  PlanBlockUpdateInput,
  PlanWeekSkipInput,
  PlanWeekUpdateInput,
} from '../schemas/plan.js';
import type { ServerState } from '../state/server-state.js';
import {
  LOCAL_USER_ID,
  type AppendBlockScheduleInput,
  type BlockScheduleKind,
  type StoredBlockSchedule,
  type StoredTrainingBlock,
  type StoredTrainingWeek,
} from '../store/types.js';
import { wrapHandler } from './helpers.js';

class ToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ToolError';
  }
}

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const PLAN_BLOCK_UPDATE_DESCRIPTION =
  'Edit a block (mesocycle): name, focus, notes or length in weeks (weeksCount). On a DATED ' +
  "block a length change records a 'resized' schedule row and moves the block's end date; " +
  'the start never moves here (that is plan.block.schedule). Refused on a block that has ' +
  'ended, when a current block would be shortened below the week it is in, and when the ' +
  'longer block would overlap another dated block (the error names it; move that block ' +
  'first). An undated block just takes the edit. `targetsAffected` lists the goal targets whose ' +
  'end moved with a resize. `warnings[]` carries the ' +
  '`meso_length_grew_mid_block` advisory when a block grows after its weeks were built.';

const PLAN_BLOCK_SCHEDULE_DESCRIPTION =
  'Date, move or un-date a block. `startsOn` is a local calendar date on a Monday; the block ' +
  'ends on the Sunday of its last week. The first date given records a planned row; a new ' +
  "date for a block that has not started records a 'moved' row; `startsOn: null` un-dates an " +
  'upcoming block and keeps the dates it had in its history. A block that has started or ' +
  'ended can never move: offer plan.week.skip for a missed week, or plan.block.update to ' +
  "change its length. `cascade: 'later_blocks'` moves every later dated block of the same " +
  'program by the same number of weeks, all in one write. Without it, a date that would ' +
  'overlap another dated block (in any active program) is refused and the error names that ' +
  'block. Dates must follow the program order: block 2 cannot start before block 1. ' +
  'Setting the date it already has writes nothing. Returns every row written with the dates ' +
  'it moved from and to. Goal targets set for a moved block follow its dates, and ' +
  '`targetsAffected` lists them (`blockId`, `targetId`, `metric`, `exerciseId`); their committed ' +
  'and stretch numbers do not change.';

const PLAN_BLOCK_SCHEDULE_HISTORY_DESCRIPTION =
  "Every schedule change a block has had, oldest first: each row's kind (planned, moved, " +
  'resized, week_skipped, cleared), the start and end in force under it, its length, its ' +
  'skipped weeks, the reason given, who made it (`user`, `coach-default` or `import`) and ' +
  'when. Use it to say how a block has moved, for example "first planned for Mon 14 Sep, ' +
  'now Mon 28 Sep". An undated block has no rows.';

const PLAN_BLOCK_CALENDAR_DESCRIPTION =
  "A block's dated calendar: start, end, state (`undated`, `upcoming`, `current`, `ended`) " +
  'and one entry per calendar week with its dates, the plan week run in it (null for an ' +
  'off week added by an extend), deload flag, name, whether it was skipped (`hold` or ' +
  '`extend`), the plan week row id, how many workout templates it holds, and the local ' +
  'dates the owner trained in it (`sessionDays`). A week with `templateCount: 0` has nothing ' +
  'planned; it is not a shorter block. An undated block returns no weeks. `history` counts ' +
  'the moves, resizes and missed weeks in its schedule and says them in one sentence (`fact`), ' +
  'for example "This block has moved twice: first planned for Mon 14 Sep, now Mon 28 Sep ' +
  '(travel)."';

const PLAN_WEEK_UPDATE_DESCRIPTION =
  'Edit one plan week: `isDeload`, `name` or `phaseType` (give at least one). The week keeps ' +
  'its place in the block; its dates come from the block schedule, never from the week.';

const PLAN_WEEK_SKIP_DESCRIPTION =
  'Record a missed week in the CURRENT block. ASK THE LIFTER EACH TIME which they want, and ' +
  'never infer it from a quiet week: `hold` keeps the calendar (the week is marked held, its ' +
  'plan week is not re-run, and the block still ends on its planned date); `extend` inserts ' +
  'an off week there, so that plan week and every later one run a week later and the block ' +
  'ends a week later. Pass `mode` with their answer. Omit `mode` only when the lifter did not ' +
  "choose: the calendar holds, recorded as the coach's default rather than their choice. " +
  '`week` is the calendar week number plan.block.calendar shows; the result echoes the ' +
  'Monday it resolved to (`weekOf`), which is what is recorded, so read it back to the ' +
  'lifter. Refused for a block that ' +
  'is not current, for a week that has not started, for a week already skipped, and for an ' +
  'extend that would run into the next dated block (the error names it). After an extend, ' +
  '`targetsAffected` lists the goal targets whose end moved; a hold moves none.';

export function registerPlanScheduleTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  install(
    placeholders,
    'plan.block.update',
    PlanBlockUpdateInput,
    PLAN_BLOCK_UPDATE_DESCRIPTION,
    (input) => updateBlock(state, input),
  );
  install(
    placeholders,
    'plan.block.schedule',
    PlanBlockScheduleInput,
    PLAN_BLOCK_SCHEDULE_DESCRIPTION,
    (input) => scheduleBlock(state, input),
  );
  install(
    placeholders,
    'plan.block.schedule_history',
    PlanBlockScheduleHistoryInput,
    PLAN_BLOCK_SCHEDULE_HISTORY_DESCRIPTION,
    (input) => scheduleHistory(state, input),
  );
  install(
    placeholders,
    'plan.block.calendar',
    PlanBlockCalendarInput,
    PLAN_BLOCK_CALENDAR_DESCRIPTION,
    (input) => readCalendar(state, input),
  );
  install(
    placeholders,
    'plan.week.update',
    PlanWeekUpdateInput,
    PLAN_WEEK_UPDATE_DESCRIPTION,
    (input) => updateWeek(state, input),
  );
  install(placeholders, 'plan.week.skip', PlanWeekSkipInput, PLAN_WEEK_SKIP_DESCRIPTION, (input) =>
    skipWeek(state, input),
  );
}

function install<T>(
  placeholders: PlaceholderTools,
  name: string,
  schema: z.ZodType<T> & { shape: z.ZodRawShape },
  description: string,
  fn: (input: T) => Promise<unknown>,
): void {
  const tool = placeholders.get(name);
  if (tool === undefined) throw new Error(`tool placeholder not registered: ${name}`);
  tool.update({
    paramsSchema: schema.shape,
    callback: wrapHandler(schema, fn),
    description,
  } as never);
}

// --- shared reads and checks ---

async function requireBlock(state: ServerState, blockId: string): Promise<StoredTrainingBlock> {
  const block = await state.store.getTrainingBlock(blockId);
  if (block === undefined) {
    throw new ToolError('NOT_FOUND', `No training block with id "${blockId}" exists.`);
  }
  return block;
}

type DatedRow = StoredBlockSchedule & { startsOn: string };

function isDated(row: StoredBlockSchedule | undefined): row is DatedRow {
  return row?.startsOn !== undefined;
}

/** The block's plain calendar as it stands, for write responses. */
export async function calendarOf(
  state: ServerState,
  blockId: string,
  today: string,
): Promise<BlockCalendar> {
  const live = await state.store.getLiveBlockSchedule(blockId);
  const weeks = await state.store.getTrainingWeeksForBlock(blockId);
  return blockCalendar(live, planWeeksOf(weeks), today);
}

function stateOn(row: DatedRow, today: string): BlockCalendar['state'] {
  return blockCalendar(row, [], today).state;
}

export function assertMonday(date: string): void {
  if (!isIsoDate(date)) {
    throw new ToolError('INVALID_DATE', `startsOn ${date} is not a calendar date.`);
  }
  if (isMonday(date)) return;
  const { before, after } = mondaysAround(date);
  throw new ToolError(
    'NOT_A_MONDAY',
    `A block starts on a Monday; ${date} is not one. The Mondays either side are ${before} and ${after}.`,
  );
}

/** I3 and I8: only a block that has not started may move or be un-dated. */
function assertUpcoming(block: StoredTrainingBlock, live: DatedRow, today: string): void {
  const state = stateOn(live, today);
  if (state === 'ended') throw endedError(block);
  if (state === 'current') {
    throw new ToolError(
      'BLOCK_STARTED',
      `"${block.name}" started on ${live.startsOn} and its start can no longer move. ` +
        'Record a missed week with plan.week.skip, or change its length with plan.block.update.',
    );
  }
}

function endedError(block: StoredTrainingBlock): ToolError {
  return new ToolError(
    'BLOCK_ENDED',
    `"${block.name}" has ended, and an ended block's schedule is closed.`,
  );
}

function placed(block: StoredTrainingBlock, row: DatedRow): PlacedBlock {
  const range = scheduleRange(row);
  return {
    blockId: block.id,
    programId: block.programId,
    orderIndex: block.orderIndex,
    name: block.name,
    startsOn: row.startsOn,
    endsOn: range === null ? row.startsOn : range.endsOn,
  };
}

/** Every dated block in a non-archived program, as its live row places it. */
export async function placedBlocks(state: ServerState): Promise<PlacedBlock[]> {
  const archived = new Map<string, boolean>();
  const out: PlacedBlock[] = [];
  for (const row of await state.store.listLiveBlockSchedules()) {
    if (!isDated(row)) continue;
    const block = await state.store.getTrainingBlock(row.blockId);
    if (block === undefined || (await isArchived(state, block.programId, archived))) continue;
    out.push(placed(block, row));
  }
  return out;
}

async function isArchived(
  state: ServerState,
  programId: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  if (!cache.has(programId)) {
    const program = await state.store.getTrainingProgram(programId);
    cache.set(programId, program?.archivedAt !== undefined);
  }
  return cache.get(programId) === true;
}

/** I2 and I7 over the world as it would be once `proposed` is written. */
async function assertPlacement(
  state: ServerState,
  proposed: readonly PlacedBlock[],
): Promise<void> {
  const changed = new Set(proposed.map((block) => block.blockId));
  const world = [
    ...(await placedBlocks(state)).filter((b) => !changed.has(b.blockId)),
    ...proposed,
  ];
  const conflict = placementConflict(world, changed);
  if (conflict === null) return;
  const { block, other } = conflict;
  const span = (b: PlacedBlock): string => `"${b.name}" (${b.startsOn} to ${b.endsOn})`;
  if (conflict.kind === 'overlap') {
    throw new ToolError('SCHEDULE_OVERLAP', `${span(block)} would overlap ${span(other)}.`);
  }
  throw new ToolError(
    'SCHEDULE_ORDER',
    `${span(block)} would be out of program order with ${span(other)}: ` +
      'dated blocks run in the order the program lists them.',
  );
}

interface RowFields {
  startsOn?: string;
  weeksCount: number;
  skips: StoredBlockSchedule['skips'];
  kind: BlockScheduleKind;
  changedBy?: StoredBlockSchedule['changedBy'];
  reason?: string;
}

function newRow(blockId: string, fields: RowFields): AppendBlockScheduleInput {
  const { reason, changedBy, ...rest } = fields;
  return {
    ...rest,
    blockId,
    changedBy: changedBy ?? 'user',
    declaredAt: new Date().toISOString(),
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** A row carrying a date, typed as one so its placement can be checked before it is written. */
function asDated(row: AppendBlockScheduleInput): DatedRow {
  return { ...row, id: '', seq: 0 } as DatedRow;
}

function rowView(row: StoredBlockSchedule): { seq: number; kind: string; changedBy: string } {
  return { seq: row.seq, kind: row.kind, changedBy: row.changedBy };
}

/** A live goal target set for a block whose dates a write just changed (VW-477). */
interface AffectedTarget {
  blockId: string;
  targetId: string;
  metric: string;
  exerciseId: string | null;
}

/**
 * The live targets set for these blocks. Their weeks, deloads and end follow the block's live
 * schedule, so they moved with it; their committed and stretch numbers did not.
 */
async function targetsAffected(
  state: ServerState,
  blockIds: readonly string[],
): Promise<AffectedTarget[]> {
  if (blockIds.length === 0) return [];
  const moved = new Set(blockIds);
  return (await state.store.listGoalTargets({ userId: LOCAL_USER_ID }))
    .filter((target) => target.blockId !== undefined && moved.has(target.blockId))
    .map((target) => ({
      blockId: target.blockId as string,
      targetId: target.id,
      metric: target.metric,
      exerciseId: target.exerciseId ?? null,
    }));
}

// --- dating a block (plan.block.create and plan.block.schedule) ---

/**
 * The 'planned' row that first dates `block`, checked and not yet written. A past Monday is
 * allowed (a block begun this week is planned on a Tuesday); a block already over is not.
 */
export async function datingRow(
  state: ServerState,
  block: StoredTrainingBlock,
  startsOn: string,
  today: string,
  reason?: string,
): Promise<AppendBlockScheduleInput> {
  assertMonday(startsOn);
  const row = newRow(block.id, {
    startsOn,
    weeksCount: block.weeksCount,
    skips: [],
    kind: 'planned',
    ...(reason !== undefined ? { reason } : {}),
  });
  if (stateOn(asDated(row), today) === 'ended') {
    throw new ToolError(
      'BLOCK_WOULD_BE_ENDED',
      `Starting on ${startsOn}, "${block.name}" would already be over.`,
    );
  }
  await assertPlacement(state, [placed(block, asDated(row))]);
  return row;
}

/**
 * What `plan.block.create` may do to a block that already has schedule history: rename it or
 * change its focus and notes. Its dates, length, program and place in the program belong to
 * the schedule tools, so I6 and I7 hold for every writer.
 */
export async function assertCreateKeepsSchedule(
  state: ServerState,
  previous: StoredTrainingBlock,
  next: StoredTrainingBlock,
  startsOn: string | undefined,
): Promise<void> {
  const live = await state.store.getLiveBlockSchedule(previous.id);
  if (live === undefined) return;
  if (startsOn !== undefined) {
    throw new ToolError(
      'USE_BLOCK_SCHEDULE',
      `"${previous.name}" has a schedule; date it with plan.block.schedule.`,
    );
  }
  if (!isDated(live)) return;
  const moved =
    previous.weeksCount !== next.weeksCount ||
    previous.orderIndex !== next.orderIndex ||
    previous.programId !== next.programId;
  if (moved) {
    throw new ToolError(
      'USE_BLOCK_UPDATE',
      `"${previous.name}" is dated, so its length, program and order are fixed here. ` +
        'Change its length with plan.block.update and its dates with plan.block.schedule.',
    );
  }
}

// --- plan.block.update ---

async function updateBlock(
  state: ServerState,
  input: z.infer<typeof PlanBlockUpdateInput>,
): Promise<{
  block: StoredTrainingBlock;
  warnings: PlanWarning[];
  calendar: BlockCalendar;
  scheduleRow: ReturnType<typeof rowView> | null;
  targetsAffected: AffectedTarget[];
}> {
  const previous = await requireBlock(state, input.blockId);
  const block: StoredTrainingBlock = {
    ...previous,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.focus !== undefined ? { focus: input.focus } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    ...(input.weeksCount !== undefined ? { weeksCount: input.weeksCount } : {}),
  };
  const today = todayLocal();
  const resize = await resizeRow(state, previous, block, today, input.reason);
  const written =
    resize === null ? null : await state.store.putTrainingBlockWithSchedule(block, resize);
  if (resize === null) await state.store.putTrainingBlock(block);
  const weeks = await state.store.getTrainingWeeksForBlock(block.id);
  return {
    block,
    warnings: lintMesoLengthGrewMidBlock({
      previousWeeksCount: previous.weeksCount,
      newWeeksCount: block.weeksCount,
      weeksAlreadyCreated: weeks.length,
    }),
    calendar: await calendarOf(state, block.id, today),
    scheduleRow: written === null ? null : rowView(written),
    targetsAffected: await targetsAffected(state, written === null ? [] : [block.id]),
  };
}

/** The 'resized' row a length change on a dated block needs (I6), or null when none is. */
async function resizeRow(
  state: ServerState,
  previous: StoredTrainingBlock,
  block: StoredTrainingBlock,
  today: string,
  reason: string | undefined,
): Promise<AppendBlockScheduleInput | null> {
  const live = await state.store.getLiveBlockSchedule(block.id);
  if (!isDated(live) || previous.weeksCount === block.weeksCount) return null;
  const calendar = blockCalendar(live, [], today);
  if (calendar.state === 'ended') throw endedError(block);
  const inProgress = planWeekInProgress(calendar.weeks, today);
  if (block.weeksCount < inProgress) {
    throw new ToolError(
      'SHORTER_THAN_TRAINED',
      `"${block.name}" is in plan week ${inProgress}; it cannot be shortened to ${block.weeksCount} weeks.`,
    );
  }
  const row = newRow(block.id, {
    startsOn: live.startsOn,
    weeksCount: block.weeksCount,
    skips: live.skips,
    kind: 'resized',
    ...(reason !== undefined ? { reason } : {}),
  });
  await assertPlacement(state, [placed(block, asDated(row))]);
  return row;
}

/** The highest plan week whose calendar week has begun; 0 before the block starts. */
function planWeekInProgress(weeks: readonly CalendarWeek[], today: string): number {
  return weeks
    .filter((week) => week.startsOn <= today && week.planWeek !== null)
    .reduce((max, week) => Math.max(max, week.planWeek ?? 0), 0);
}

// --- plan.block.schedule ---

interface ScheduleChange {
  previous: StoredBlockSchedule | undefined;
  next: AppendBlockScheduleInput;
}

type DateRange = { startsOn: string; endsOn: string } | null;

async function scheduleBlock(
  state: ServerState,
  input: z.infer<typeof PlanBlockScheduleInput>,
): Promise<{
  block: StoredTrainingBlock;
  calendar: BlockCalendar;
  rows: { blockId: string; seq: number; kind: string; from: DateRange; to: DateRange }[];
  targetsAffected: AffectedTarget[];
}> {
  const block = await requireBlock(state, input.blockId);
  const today = todayLocal();
  const changes = await scheduleChanges(state, block, input, today);
  const written =
    changes.length === 0 ? [] : await state.store.appendBlockSchedules(changes.map((c) => c.next));
  const rows = written.map((row, index) => ({
    blockId: row.blockId,
    seq: row.seq,
    kind: row.kind,
    from: rangeOf(changes[index].previous),
    to: rangeOf(row),
  }));
  return {
    block,
    calendar: await calendarOf(state, block.id, today),
    rows,
    targetsAffected: await targetsAffected(
      state,
      written.map((row) => row.blockId),
    ),
  };
}

function rangeOf(row: StoredBlockSchedule | undefined): DateRange {
  return row === undefined ? null : scheduleRange(row);
}

async function scheduleChanges(
  state: ServerState,
  block: StoredTrainingBlock,
  input: z.infer<typeof PlanBlockScheduleInput>,
  today: string,
): Promise<ScheduleChange[]> {
  const live = await state.store.getLiveBlockSchedule(block.id);
  const reason = input.reason !== undefined ? { reason: input.reason } : {};
  if (isDated(live)) assertUpcoming(block, live, today);
  if (input.startsOn === null) {
    if (!isDated(live)) return [];
    const next = newRow(block.id, {
      weeksCount: live.weeksCount,
      skips: live.skips,
      kind: 'cleared',
      ...reason,
    });
    return [{ previous: live, next }];
  }
  if (!isDated(live)) {
    return [
      { previous: live, next: await datingRow(state, block, input.startsOn, today, input.reason) },
    ];
  }
  if (live.startsOn === input.startsOn) return [];
  return moveChanges(state, block, live, { ...input, startsOn: input.startsOn }, today);
}

async function moveChanges(
  state: ServerState,
  block: StoredTrainingBlock,
  live: DatedRow,
  input: z.infer<typeof PlanBlockScheduleInput> & { startsOn: string },
  today: string,
): Promise<ScheduleChange[]> {
  assertMonday(input.startsOn);
  const shiftDays = Math.round((Date.parse(input.startsOn) - Date.parse(live.startsOn)) / DAY_MS);
  const later = input.cascade === 'later_blocks' ? await laterDatedBlocks(state, block) : [];
  const moves = [{ block, live }, ...later];
  const changes = moves.map(({ block: moving, live: row }) => {
    assertUpcoming(moving, row, today);
    const next = newRow(moving.id, {
      startsOn: addDays(row.startsOn, shiftDays),
      weeksCount: row.weeksCount,
      skips: row.skips,
      kind: 'moved',
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });
    if (stateOn(asDated(next), today) === 'ended') {
      throw new ToolError(
        'BLOCK_WOULD_BE_ENDED',
        `Moved to ${next.startsOn}, "${moving.name}" would already be over.`,
      );
    }
    return { previous: row, next, moving };
  });
  await assertPlacement(
    state,
    changes.map((change) => placed(change.moving, asDated(change.next))),
  );
  return changes.map(({ previous, next }) => ({ previous, next }));
}

/** The dated blocks after `block` in its program, in program order. */
async function laterDatedBlocks(
  state: ServerState,
  block: StoredTrainingBlock,
): Promise<{ block: StoredTrainingBlock; live: DatedRow }[]> {
  const out: { block: StoredTrainingBlock; live: DatedRow }[] = [];
  for (const other of await state.store.getTrainingBlocksForProgram(block.programId)) {
    if (other.orderIndex <= block.orderIndex || other.id === block.id) continue;
    const live = await state.store.getLiveBlockSchedule(other.id);
    if (isDated(live)) out.push({ block: other, live });
  }
  return out;
}

// --- plan.block.schedule_history ---

async function scheduleHistory(
  state: ServerState,
  input: z.infer<typeof PlanBlockScheduleHistoryInput>,
): Promise<{ rows: object[] }> {
  await requireBlock(state, input.blockId);
  const history = await state.store.listBlockScheduleHistory(input.blockId);
  const rows = history.map((row) => ({
    seq: row.seq,
    kind: row.kind,
    startsOn: row.startsOn ?? null,
    endsOn: scheduleRange(row)?.endsOn ?? null,
    weeksCount: row.weeksCount,
    skips: row.skips,
    reason: row.reason ?? null,
    changedBy: row.changedBy,
    declaredAt: row.declaredAt,
  }));
  return { rows };
}

// --- plan.block.calendar ---

interface CalendarWeekView extends CalendarWeek {
  weekId: string | null;
  templateCount: number;
  sessionDays: string[];
}

async function readCalendar(
  state: ServerState,
  input: z.infer<typeof PlanBlockCalendarInput>,
): Promise<{
  block: StoredTrainingBlock;
  calendar: Omit<BlockCalendar, 'weeks'> & { weeks: CalendarWeekView[] };
  history: ScheduleHistory;
}> {
  const block = await requireBlock(state, input.blockId);
  const live = await state.store.getLiveBlockSchedule(block.id);
  const weekRows = await state.store.getTrainingWeeksForBlock(block.id);
  const calendar = blockCalendar(live, planWeeksOf(weekRows), todayLocal());
  const days = await trainingDaysBetween(state, calendar.startsOn, calendar.endsOn);
  const weeks: CalendarWeekView[] = [];
  for (const week of calendar.weeks) {
    const row =
      week.planWeek === null ? undefined : weekRows.find((w) => w.orderIndex + 1 === week.planWeek);
    weeks.push({
      ...week,
      weekId: row?.id ?? null,
      templateCount:
        row === undefined ? 0 : (await state.store.getWorkoutTemplatesForWeek(row.id)).length,
      sessionDays: days.filter((day) => week.startsOn <= day && day <= week.endsOn),
    });
  }
  const history = historyOf(await state.store.listBlockScheduleHistory(block.id));
  return { block, calendar: { ...calendar, weeks }, history };
}

/** The owner's local training days between two local dates, inclusive. */
export async function trainingDaysBetween(
  state: ServerState,
  startsOn: string | null,
  endsOn: string | null,
): Promise<string[]> {
  if (startsOn === null || endsOn === null) return [];
  // A session is filed by the local date it ENDED on; widen the start-time window by a day each side.
  const ends = await state.store.listTrainingDayInstants({
    from: new Date(Date.parse(startsOn) - DAY_MS).toISOString(),
    to: new Date(Date.parse(endsOn) + 2 * DAY_MS).toISOString(),
  });
  const days = ends.map(localDate).filter((day) => startsOn <= day && day <= endsOn);
  return [...new Set(days)].sort();
}

// --- plan.week.update ---

async function updateWeek(
  state: ServerState,
  input: z.infer<typeof PlanWeekUpdateInput>,
): Promise<{ week: StoredTrainingWeek }> {
  if (input.isDeload === undefined && input.name === undefined && input.phaseType === undefined) {
    throw new ToolError('INVALID_INPUT', 'Give at least one of isDeload, name or phaseType.');
  }
  const previous = await state.store.getTrainingWeek(input.weekId);
  if (previous === undefined) {
    throw new ToolError('NOT_FOUND', `No training week with id "${input.weekId}" exists.`);
  }
  const week: StoredTrainingWeek = {
    ...previous,
    ...(input.isDeload !== undefined ? { isDeload: input.isDeload } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.phaseType !== undefined ? { phaseType: input.phaseType } : {}),
  };
  await state.store.putTrainingWeek(week);
  return { week };
}

// --- plan.week.skip ---

async function skipWeek(
  state: ServerState,
  input: z.infer<typeof PlanWeekSkipInput>,
): Promise<{
  weekOf: string;
  calendar: BlockCalendar;
  targetsAffected: AffectedTarget[];
  scheduleRow: ReturnType<typeof rowView>;
}> {
  const block = await requireBlock(state, input.blockId);
  const today = todayLocal();
  const live = await state.store.getLiveBlockSchedule(block.id);
  const week = skippableWeek(block, live, input.week, today);
  const next = newRow(block.id, {
    startsOn: week.live.startsOn,
    weeksCount: week.live.weeksCount,
    skips: [
      ...week.live.skips,
      {
        weekOf: week.startsOn,
        mode: input.mode ?? 'hold',
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      },
    ],
    kind: 'week_skipped',
    changedBy: input.mode === undefined ? 'coach-default' : 'user',
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
  if (input.mode === 'extend') await assertPlacement(state, [placed(block, asDated(next))]);
  const written = await state.store.appendBlockSchedule(next);
  return {
    weekOf: week.startsOn,
    calendar: await calendarOf(state, block.id, today),
    scheduleRow: rowView(written),
    // A hold keeps every week where it was; an extend moves the block's end.
    targetsAffected: await targetsAffected(state, input.mode === 'extend' ? [block.id] : []),
  };
}

function skippableWeek(
  block: StoredTrainingBlock,
  live: StoredBlockSchedule | undefined,
  weekNumber: number,
  today: string,
): CalendarWeek & { live: DatedRow } {
  if (!isDated(live)) {
    throw new ToolError(
      'BLOCK_UNDATED',
      `"${block.name}" has no dates, so it has no weeks to skip.`,
    );
  }
  const calendar = blockCalendar(live, [], today);
  if (calendar.state === 'ended') throw endedError(block);
  if (calendar.state === 'upcoming') {
    throw new ToolError(
      'BLOCK_NOT_STARTED',
      `"${block.name}" starts on ${live.startsOn}; nothing in it can be missed yet.`,
    );
  }
  const week = calendar.weeks[weekNumber - 1];
  if (week === undefined) {
    throw new ToolError(
      'WEEK_NOT_FOUND',
      `"${block.name}" has ${calendar.weeks.length} calendar weeks, not ${weekNumber}.`,
    );
  }
  if (week.startsOn > today) {
    throw new ToolError(
      'WEEK_NOT_STARTED',
      `Week ${weekNumber} starts on ${week.startsOn}; it has not been missed yet.`,
    );
  }
  if (week.skipped !== null) {
    throw new ToolError(
      'WEEK_ALREADY_SKIPPED',
      `Week ${weekNumber} is already recorded as ${week.skipped}.`,
    );
  }
  return { ...week, live };
}
