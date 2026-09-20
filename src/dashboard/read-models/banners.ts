// The dashboard banner read (VW-504, coach stage 1.5): what the wall should say is worth the
// lifter's attention, derived from stored plan and session state. A read only — nothing here
// writes, and the clock is always a parameter so a fixture can pin it.
//
// No training vocabulary in the record's field names. A banner is a kind, a tone, two lines of
// copy and somewhere to go; a later producer from another domain fits the same shape without
// anything being renamed.
//
// BANNER_PRIORITY is an ENGINEERING DEFAULT, not an owner ruling: the order puts a hardware
// fault above bookkeeping and bookkeeping above browsing. Only `unrecorded_week` has a producer
// today; the other five are named now so the order is settled before their producers land.

import {
  localMidnightIso,
  readTrainingDaysMatching,
  type TrainingDayStore,
} from '../../analytics/training-days.js';
import { addDays, type BlockCalendar, type CalendarWeek } from '../../plan/block-calendar.js';
import { resolveCurrentBlock, type CurrentBlockStore } from '../../plan/current-block.js';
import { shortDate } from '../../plan/schedule-history.js';

export type BannerTone = 'info' | 'attention' | 'warning' | 'success';

/** Highest priority first. The one order every banner surface reads. */
export const BANNER_PRIORITY = [
  'device_fault',
  'unrecorded_week',
  'planning_due',
  'checkin_due',
  'target_ready',
  'history_review',
] as const;

export type BannerKind = (typeof BANNER_PRIORITY)[number];

export interface BannerRecord {
  kind: BannerKind;
  tone: BannerTone;
  title: string;
  subtitle: string | null;
  /** The SPA hash route the banner sends the lifter to. */
  destination: string;
  dismissible: boolean;
  /** The read the banner was derived from, so a consumer can trace it back. */
  source: string;
}

const UNRECORDED_WEEK_SOURCE = 'plan.block-calendar';

// Placeholder copy (VW-504): awaiting the owner's wording.
const UNRECORDED_WEEK_TITLE = 'A planned week went unrecorded';

/**
 * The calendar weeks that carried a plan week, have fully passed, were never recorded as
 * skipped, and hold no training day. A deload week with no training day counts: a deload is
 * planned training, so an empty one is still an unrecorded week (ENGINEERING DEFAULT).
 */
export function unrecordedWeeks(
  calendar: BlockCalendar,
  trainingDays: readonly string[],
  today: string,
): CalendarWeek[] {
  return calendar.weeks.filter(
    (week) =>
      week.endsOn < today &&
      week.skipped === null &&
      week.planWeek !== null &&
      !trainingDays.some((day) => week.startsOn <= day && day <= week.endsOn),
  );
}

/** One record for the whole run of unrecorded weeks, naming the most recent. */
export function unrecordedWeekBanner(weeks: readonly CalendarWeek[]): BannerRecord | null {
  const latest = weeks.at(-1);
  if (latest === undefined) return null;
  return {
    kind: 'unrecorded_week',
    tone: 'attention',
    title: UNRECORDED_WEEK_TITLE,
    subtitle: unrecordedWeekSubtitle(weeks.length, latest.startsOn),
    destination: '#/plan',
    dismissible: false,
    source: UNRECORDED_WEEK_SOURCE,
  };
}

// Placeholder copy (VW-504): awaiting the owner's wording.
function unrecordedWeekSubtitle(count: number, latestStartsOn: string): string {
  const week = `the week of ${shortDate(latestStartsOn)}`;
  if (count === 1) return `The week of ${shortDate(latestStartsOn)} had no training day.`;
  return `${count} planned weeks had no training day, the most recent ${week}.`;
}

/** Candidates in {@link BANNER_PRIORITY} order, highest first. */
export function sortByPriority(banners: readonly BannerRecord[]): BannerRecord[] {
  return [...banners].sort(
    (a, b) => BANNER_PRIORITY.indexOf(a.kind) - BANNER_PRIORITY.indexOf(b.kind),
  );
}

export type BannerStore = CurrentBlockStore & TrainingDayStore;

/** Every banner that currently holds, highest priority first. */
export async function readBanners(
  store: BannerStore,
  today: string,
  nowIso: string,
): Promise<BannerRecord[]> {
  const candidates = [await readUnrecordedWeekBanner(store, today, nowIso)];
  return sortByPriority(candidates.filter((banner) => banner !== null));
}

/** The one banner a single-banner surface shows, or `null` when nothing holds. */
export async function readTopBanner(
  store: BannerStore,
  today: string,
  nowIso: string,
): Promise<BannerRecord | null> {
  return (await readBanners(store, today, nowIso))[0] ?? null;
}

async function readUnrecordedWeekBanner(
  store: BannerStore,
  today: string,
  nowIso: string,
): Promise<BannerRecord | null> {
  const { state, calendar } = await resolveCurrentBlock(store, today);
  // 'current' only (VW-504): a 'gap' block has ended and neither clearing route reaches it.
  if (state !== 'current' || calendar === null || calendar.startsOn === null) return null;
  const trainingDays = await readTrainingDaysMatching(store, {
    // Sessions are filtered on their START instant while a training day is the local date of the
    // END instant, so the window opens a day early rather than dropping one that ran past midnight.
    from: localMidnightIso(addDays(calendar.startsOn, -1)),
    to: nowIso,
  });
  return unrecordedWeekBanner(unrecordedWeeks(calendar, trainingDays, today));
}
