// `accountability.state` — a READ-ONLY window on the coach's protocol position
// (VW-286).
//
// Two things in one response: the persisted state (from `accountability_state`)
// and a DRY RUN of what the reducer would decide right now. The dry run writes
// nothing and sends nothing — there is no transport wired into this tool, by
// design: the scheduled job owns sending, this tool exists so a human can ask
// "why has the coach been quiet" and get the reason rather than a shrug.
//
// The adherence direction comes from `report.weekly`'s `WeeklyAdherence.trend`
// and never from a planned/done count: the escalation ladder is keyed to
// direction, and a raw count would let a bad week read as a trend.

import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

import {
  initialAccountabilityState,
  reduceAccountability,
  PROACTIVE_WINDOW_MS,
} from '../accountability/state-machine.js';
import {
  fixedClock,
  type AccountabilityDecision,
  type AccountabilityEvent,
  type AccountabilityState,
  type AdherenceTrend,
  type ProtocolState,
} from '../accountability/types.js';
import { AccountabilityStateInput } from '../schemas/accountability.js';
import type { ServerState } from '../state/server-state.js';
import { LOCAL_USER_ID } from '../store/types.js';
import { wrapHandler } from './helpers.js';
import { buildWeeklyReport } from './report-tools.js';

const SUNDAY = 0;
const THURSDAY = 4;
const MONDAY = 1;
const TUESDAY = 2;

export const ACCOUNTABILITY_STATE_DESCRIPTION =
  'READ-ONLY. Report the coach accountability protocol state for the owner and the decision the ' +
  'protocol would make right now, without writing anything and without sending anything. ' +
  'Returns `protocolState` (planned / completed / missed / ghosting / realign_needed / holding), ' +
  '`enteredAt`, `consecutiveMisses`, `lastInboundAt`, `holdingUntil`, `ghostSendsThisEpisode`, ' +
  '`proactiveSendsInWindow` (the rolling 7-day count the 2-message ceiling is enforced against), ' +
  '`persisted` (false when no row exists yet and the defaults are being shown), ' +
  '`evaluatedAt` (the instant the dry run was evaluated at), plus `tick` ' +
  '(`sunday_anchor` on a Sunday, `thursday` on a Thursday, `none` on every other day), ' +
  '`adherenceTrend` read from `report.weekly`, and `decision` — `{action, kind, reason}` where ' +
  '`action` is `send` or `silent` and `reason` always says why, including why it is silent. ' +
  'Pass `at` to evaluate the dry run as of another instant. No device traffic, no network.';

interface PlaceholderTools {
  get(name: string): RegisteredTool | undefined;
}

export interface AccountabilityStateResult {
  protocolState: ProtocolState;
  enteredAt: string;
  consecutiveMisses: number;
  lastInboundAt: string | null;
  holdingUntil: string | null;
  ghostSendsThisEpisode: number;
  proactiveSendsInWindow: number;
  persisted: boolean;
  evaluatedAt: string;
  tick: 'sunday_anchor' | 'thursday' | 'none';
  adherenceTrend: AdherenceTrend | null;
  decision: AccountabilityDecision;
}

export function registerAccountabilityTools(
  _server: McpServer,
  state: ServerState,
  placeholders: PlaceholderTools,
): void {
  const tool = placeholders.get('accountability.state');
  if (tool === undefined) {
    throw new Error('tool placeholder not registered: accountability.state');
  }
  tool.update({
    paramsSchema: AccountabilityStateInput.shape,
    callback: wrapHandler(
      AccountabilityStateInput,
      (input: z.infer<typeof AccountabilityStateInput>) =>
        describeAccountabilityState(state, input),
    ) as never,
    description: ACCOUNTABILITY_STATE_DESCRIPTION,
  } as never);
}

export async function describeAccountabilityState(
  state: ServerState,
  input: z.infer<typeof AccountabilityStateInput>,
): Promise<AccountabilityStateResult> {
  const now = input.at === undefined ? new Date() : new Date(input.at);
  const stored = await state.store.getAccountabilityState(LOCAL_USER_ID);
  const current = stored ?? initialAccountabilityState(LOCAL_USER_ID, now);
  const tick = tickForDay(now);
  const trend = tick === 'thursday' ? await readAdherenceTrend(state) : null;
  return {
    protocolState: current.state,
    enteredAt: current.enteredAt,
    consecutiveMisses: current.consecutiveMisses,
    lastInboundAt: current.lastInboundAt,
    holdingUntil: current.holdingUntil,
    ghostSendsThisEpisode: current.ghostSends.length,
    proactiveSendsInWindow: sendsInWindow(current, now),
    persisted: stored !== undefined,
    evaluatedAt: now.toISOString(),
    tick,
    adherenceTrend: trend,
    decision: dryRunDecision(current, tick, trend, now),
  };
}

/**
 * The decision the reducer WOULD make, discarding the state it returns. On a
 * day with no scheduled tick there is no event to fold, and saying so is the
 * honest answer — the protocol is event-driven, not a daily cron.
 */
function dryRunDecision(
  current: AccountabilityState,
  tick: AccountabilityStateResult['tick'],
  trend: AdherenceTrend | null,
  now: Date,
): AccountabilityDecision {
  if (tick === 'none') {
    return {
      action: 'silent',
      reason:
        'no scheduled tick today: the Sunday anchor is the only fixed touch and the mid-week ' +
        'touch fires on a Thursday. Everything else is event-driven',
    };
  }
  const event: AccountabilityEvent =
    tick === 'sunday_anchor'
      ? { type: 'sunday_anchor_tick' }
      : {
          type: 'thursday_tick',
          earlyWeekMiss: enteredMissedOnMonOrTue(current),
          plannedSessionSkippedSinceSunday: current.state === 'missed',
          adherenceTrend: trend,
        };
  return reduceAccountability(current, event, fixedClock(now)).decision;
}

/**
 * The Thursday trigger needs "a Mon or Tue planned session is missed", and the
 * only thing the stored row knows is when it entered `missed`. A real tick gets
 * the flag from the caller, which knows the plan; this dry run derives it, so
 * a miss detected later in the week reads as no early-week miss.
 */
function enteredMissedOnMonOrTue(current: AccountabilityState): boolean {
  if (current.state !== 'missed') return false;
  const day = new Date(current.enteredAt).getDay();
  return day === MONDAY || day === TUESDAY;
}

async function readAdherenceTrend(state: ServerState): Promise<AdherenceTrend | null> {
  const report = await buildWeeklyReport(state, { format: 'json' });
  return report.header.adherence?.trend ?? null;
}

function tickForDay(now: Date): AccountabilityStateResult['tick'] {
  // Local weekday, because the lifter's week is local; the reducer itself is
  // timezone-agnostic and takes the tick as an event.
  const day = now.getDay();
  if (day === SUNDAY) return 'sunday_anchor';
  if (day === THURSDAY) return 'thursday';
  return 'none';
}

function sendsInWindow(current: AccountabilityState, now: Date): number {
  const cutoff = now.getTime() - PROACTIVE_WINDOW_MS;
  return current.proactiveSends.filter((s) => Date.parse(s.at) > cutoff).length;
}
