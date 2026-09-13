// Shared types for the accountability protocol (VW-286, plan §2).
//
// This module is the contract between the reducer (which decides WHEN the
// coach speaks) and the composer (VW-287, which decides WHAT it says). The
// reducer never writes message text and the composer never advances state, so
// everything they both need lives here.

/**
 * The protocol states from the plan's §2 table. `planned` is the resting
 * state; `realign_needed` is terminal for automatic transitions (the
 * escalation ceiling is a binding human decision: nudge -> realign
 * conversation -> stop).
 */
export type ProtocolState =
  | 'planned'
  | 'completed'
  | 'missed'
  | 'ghosting'
  | 'realign_needed'
  | 'holding';

/**
 * What kind of proactive message a `send` decision asks for. These name entries
 * in the composer's copy pack, NOT states: a Thursday tick fired by a flat
 * trend asks for a `realign_opener` without the machine entering
 * `realign_needed`.
 */
export type ProactiveKind = 'sunday_anchor' | 'miss_recovery' | 'ghost_nudge' | 'realign_opener';

/**
 * `report.weekly`'s adherence direction (`WeeklyAdherence['trend']`, built by
 * `buildWeeklyReport`). The escalation ladder is keyed to direction, never to
 * a raw planned/done count, so the count never reaches this module.
 */
export type AdherenceTrend = 'improving' | 'declining' | 'steady' | 'no-prior-data';

/** One proactive message the coach sent, with the kind that produced it. */
export interface ProactiveSend {
  at: string;
  kind: ProactiveKind;
}

/**
 * The persisted protocol state for one user — one row of `accountability_state`.
 *
 * `ghostSends` counts the CURRENT ghost episode only (any inbound clears it),
 * which is what the "4 total, then stop" ceiling is counted against.
 * `proactiveSends` is every proactive send, trimmed to the recent past, and is
 * what the rolling 7-day ceiling reads.
 */
export interface AccountabilityState {
  userId: string;
  state: ProtocolState;
  enteredAt: string;
  consecutiveMisses: number;
  ghostSends: string[];
  lastInboundAt: string | null;
  proactiveSends: ProactiveSend[];
  holdingUntil: string | null;
}

/**
 * Events the reducer folds. Every one of them is an observation someone else
 * made: telemetry, an inbound reply, a scheduled tick, or a human declaring a
 * disruption. The reducer derives nothing from the store itself.
 */
export type AccountabilityEvent =
  /** A session was recorded against a planned slot (its own day or its named fallback day). */
  | { type: 'session_completed' }
  /** The planned day AND its named fallback day both passed with no session. */
  | { type: 'planned_session_missed' }
  /** Any reply from the lifter, at any latency. */
  | { type: 'inbound_reply' }
  /** The fixed weekly anchor tick (Sunday). */
  | { type: 'sunday_anchor_tick' }
  /**
   * The dynamic mid-week tick. The three trigger facts are supplied by the
   * caller because the reducer is pure: `earlyWeekMiss` is a missed Mon or Tue
   * planned session, `plannedSessionSkippedSinceSunday` is any planned session
   * skipped since the last anchor, `adherenceTrend` comes from `report.weekly`.
   */
  | {
      type: 'thursday_tick';
      earlyWeekMiss: boolean;
      plannedSessionSkippedSinceSunday: boolean;
      adherenceTrend: AdherenceTrend | null;
    }
  /** A human declared a disruption window ending at `until` (ISO-8601). */
  | { type: 'holding_declared'; until: string }
  /** The disruption window is over, declared or elapsed. */
  | { type: 'holding_ended' }
  /**
   * A refreshed deviation-frequency read. `sustainedMesocycles` is how many
   * consecutive mesocycles the direction has held — the ladder escalates on a
   * trend across mesocycles, never on one week.
   */
  | { type: 'deviation_trend_updated'; trend: AdherenceTrend; sustainedMesocycles: number };

/**
 * What the coach should do right now. `reason` is always populated, including
 * for `silent`: the whole point of a suppressed message is that someone can
 * ask later why nothing was sent.
 */
export type AccountabilityDecision =
  | { action: 'send'; kind: ProactiveKind; reason: string }
  | { action: 'silent'; reason: string };

/**
 * Live-read shapes the composer (VW-287) renders from. Declared here, not in
 * `composer.ts`, so the reducer's `AdherenceTrend` and `ProactiveKind` are the
 * only definitions of those concepts anywhere in the module — a caller (a
 * tool handler) builds one of these from a store read or a report and the
 * composer never touches the store itself.
 */

/** Shaped like `WeeklyAdherence`'s header (`report.weekly`, `src/tools/report-tools.ts`). */
export interface AdherenceRead {
  planned: number;
  done: number;
  trend: AdherenceTrend;
}

export interface NextWorkoutExercise {
  name: string;
  targetWeightLbs?: number;
}

/** Shaped like `plan.next_workout`'s result, with exercise ids already resolved to names. */
export interface NextWorkoutRead {
  templateName: string;
  exercises: NextWorkoutExercise[];
}

/** One planned day and the fallback day that also counts as done (LIT §3.5). */
export interface PlannedSlot {
  day: string;
  fallbackDay: string;
}

export interface MissedSessionFacts {
  plannedDay: string;
  fallbackDay: string;
  exerciseNames: string[];
}

/** A declared disruption window. `endDate` is whatever the lifter named, rendered as given. */
export interface HoldingRead {
  active: boolean;
  endDate?: string;
}

/** The reducer's return: the next state plus the decision that goes with it. */
export interface AccountabilityTransition {
  state: AccountabilityState;
  decision: AccountabilityDecision;
}

/** Injected time source. Every date the reducer writes comes from here. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock pinned to one instant, for tests and for a dry-run evaluation. */
export function fixedClock(at: Date | string): Clock {
  const instant = typeof at === 'string' ? new Date(at) : at;
  return { now: () => new Date(instant.getTime()) };
}
