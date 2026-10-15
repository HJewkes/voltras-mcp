import type { ExerciseSummary, SessionSet, SessionSummary, Tone, Units, VerdictState } from './types';

export const VERDICT_LABEL: Record<VerdictState, string> = {
  good: 'Good',
  slowing: 'Slowing',
  grinding: 'Grinding',
  'form-breakdown': 'Form breaking down',
};

export const TONE_WORD: Record<Tone, string> = { ok: 'OK', warn: 'Watch', alarm: 'Problem' };

const LB_TO_KG = 0.45359237;

export function convertLoad(lbs: number, units: Units): number {
  if (units === 'lb') return Math.round(lbs);
  return Math.round(lbs * LB_TO_KG * 2) / 2;
}

export function formatLoad(lbs: number, units: Units): string {
  return `${convertLoad(lbs, units).toLocaleString('en-US')} ${units}`;
}

// The progression delta is a fixed 5 lb step; in kg it is shown as the honest
// conversion rather than a rounded plate number.
export function formatDelta(lbs: number, units: Units): string {
  if (units === 'lb') return `${Math.abs(lbs)} lb`;
  return `${(Math.abs(lbs) * LB_TO_KG).toFixed(1)} kg`;
}

export function epley1rm(weightLbs: number, reps: number): number {
  return reps <= 1 ? weightLbs : weightLbs * (1 + reps / 30);
}

export interface SetE1rm {
  set: SessionSet;
  e1rm: number;
}

export function workingE1rms(ex: ExerciseSummary): SetE1rm[] {
  return ex.sets
    .filter((s) => s.setPurpose === 'working' && s.weightLbs !== null && s.repCount > 0)
    .map((s) => ({ set: s, e1rm: epley1rm(s.weightLbs as number, s.repCount) }));
}

export interface StrengthSummary {
  best: SetE1rm;
  first: number;
  last: number;
  changePct: number | null;
}

export function strengthSummary(ex: ExerciseSummary): StrengthSummary | null {
  const points = workingE1rms(ex);
  if (points.length === 0) return null;
  const best = points.reduce((a, b) => (b.e1rm > a.e1rm ? b : a));
  const first = points[0].e1rm;
  const last = points[points.length - 1].e1rm;
  const changePct = points.length > 1 ? ((last - first) / first) * 100 : null;
  return { best, first, last, changePct };
}

export function bestE1rmIndex(ex: ExerciseSummary): number | null {
  return strengthSummary(ex)?.best.set.index ?? null;
}

export function restBeforeSec(ex: ExerciseSummary, i: number): number | null {
  if (i === 0) return null;
  return (Date.parse(ex.sets[i].startedAt) - Date.parse(ex.sets[i - 1].endedAt)) / 1000;
}

export function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface SessionDuration {
  minutes: number;
  isLowerBound: boolean;
}

export function sessionDuration(summary: SessionSummary): SessionDuration | null {
  const start = Date.parse(summary.session.startedAt);
  if (summary.session.endedAt) {
    return { minutes: Math.round((Date.parse(summary.session.endedAt) - start) / 60000), isLowerBound: false };
  }
  const ends = summary.exercises.flatMap((e) => e.sets.map((s) => Date.parse(s.endedAt)));
  if (ends.length === 0) return null;
  return { minutes: Math.round((Math.max(...ends) - start) / 60000), isLowerBound: true };
}

export interface SessionTotals {
  workingSets: number;
  warmupSets: number;
  totalReps: number;
  volumeLbs: number | null;
  unloadedSets: number;
}

export function sessionTotals(summary: SessionSummary): SessionTotals {
  const sets = summary.exercises.flatMap((e) => e.sets);
  const volumes = summary.exercises.map((e) => e.volumeLbs).filter((v): v is number => v !== null);
  return {
    workingSets: summary.exercises.reduce((n, e) => n + e.workingSetCount, 0),
    warmupSets: sets.filter((s) => s.setPurpose !== 'working').length,
    totalReps: sets.reduce((n, s) => n + s.repCount, 0),
    volumeLbs: volumes.length ? volumes.reduce((a, b) => a + b, 0) : null,
    unloadedSets: sets.filter((s) => s.weightLbs === null).length,
  };
}

export type VlBand = 'fresh' | 'productive' | 'hard' | 'near-failure';

export function vlBand(pct: number): VlBand {
  if (pct < 10) return 'fresh';
  if (pct < 20) return 'productive';
  if (pct < 30) return 'hard';
  return 'near-failure';
}

export const VL_BAND_LABEL: Record<VlBand, string> = {
  fresh: 'fresh',
  productive: 'productive',
  hard: 'hard',
  'near-failure': 'near failure',
};

export function noVerdictReason(ex: ExerciseSummary): string {
  if (ex.name === 'Unattributed') return 'Sets named no exercise';
  const working = ex.sets.filter((s) => s.setPurpose === 'working');
  if (working.every((s) => s.velocityLossPct === null)) return 'No velocity data was recorded';
  return 'No verdict for this exercise';
}

export function sessionTitle(summary: SessionSummary): { day: string; time: string } {
  const start = new Date(summary.session.startedAt);
  const day = start.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  const time = start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  return { day, time };
}
