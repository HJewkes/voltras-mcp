import type { ExerciseSummary, SessionSet, SessionSummary, SetPurpose, Tone, VerdictState } from './types'

export const VERDICT_LABEL: Record<VerdictState, string> = {
  good: 'Good',
  slowing: 'Slowing',
  grinding: 'Grinding',
  'form-breakdown': 'Form breaking down',
}

export const PURPOSE_LABEL: Record<SetPurpose, string> = {
  working: 'Working',
  warmup: 'Warm-up',
  probe: 'Probe',
  technique: 'Technique',
}

export const TONE_WORD: Record<Tone, string> = { ok: 'OK', warn: 'Watch', alarm: 'Alarm' }

/** Epley; only meaningful for sets with a recorded load. */
export function estimateOneRepMax(weightLbs: number, reps: number): number {
  return weightLbs * (1 + reps / 30)
}

export function setOneRepMax(set: SessionSet): number | null {
  if (set.setPurpose !== 'working' || set.weightLbs === null) return null
  return estimateOneRepMax(set.weightLbs, set.repCount)
}

export interface Trend {
  first: number
  last: number
  changePct: number
}

function trendOf(values: number[]): Trend | null {
  if (values.length < 2) return null
  const first = values[0]
  const last = values[values.length - 1]
  return { first, last, changePct: ((last - first) / first) * 100 }
}

export function workingSets(exercise: ExerciseSummary): SessionSet[] {
  return exercise.sets.filter((s) => s.setPurpose === 'working')
}

export function strengthTrend(exercise: ExerciseSummary): Trend | null {
  const values = workingSets(exercise).map(setOneRepMax).filter((v): v is number => v !== null)
  return trendOf(values)
}

export function fatigueTrend(exercise: ExerciseSummary): Trend | null {
  const values = workingSets(exercise)
    .map((s) => s.velocityLossPct)
    .filter((v): v is number => v !== null)
  return trendOf(values)
}

export type RepOutcome = 'below' | 'in' | 'above'

export interface ScoredSet {
  set: SessionSet
  outcome: RepOutcome
}

/** Mirrors what progression reads: loaded working sets against the target rep range. */
export function scoreAgainstTarget(exercise: ExerciseSummary): ScoredSet[] {
  const p = exercise.progression
  if (!p) return []
  return workingSets(exercise)
    .filter((s) => s.weightLbs !== null)
    .map((set) => ({
      set,
      outcome: set.repCount < p.targetRepsLow ? 'below' : set.repCount > p.targetRepsHigh ? 'above' : 'in',
    }))
}

export type Agreement = 'agree' | 'speed-fine-reps-short' | 'reps-fine-speed-dropped'

/** The verdict reads bar speed; progression reads reps. Name the case where they point opposite ways. */
export function agreementOf(exercise: ExerciseSummary): Agreement | null {
  const { verdict, progression } = exercise
  if (!verdict || !progression) return null
  if (verdict.tone === 'ok' && progression.delta < 0) return 'speed-fine-reps-short'
  if (verdict.tone !== 'ok' && progression.delta > 0) return 'reps-fine-speed-dropped'
  return 'agree'
}

export function noVerdictReason(exercise: ExerciseSummary): string {
  if (exercise.workingSetCount === 0) return 'No working sets: the verdict reads working sets only.'
  return 'No bar-speed data on the working sets, so there is nothing to judge.'
}

export function restBeforeMs(set: SessionSet, all: SessionSet[]): number | null {
  const previous = all.find((s) => s.index === set.index - 1)
  if (!previous) return null
  return new Date(set.startedAt).getTime() - new Date(previous.endedAt).getTime()
}

export function allSets(summary: SessionSummary): SessionSet[] {
  return summary.exercises.flatMap((e) => e.sets).sort((a, b) => a.index - b.index)
}

export interface SessionTotals {
  setCount: number
  workingSetCount: number
  totalReps: number
  volumeLbs: number | null
  unloadedSetLabels: string[]
  lastSetEndedAt: string | null
}

export function sessionTotals(summary: SessionSummary): SessionTotals {
  const ex = summary.exercises
  const loaded = ex.filter((e) => e.volumeLbs !== null)
  const sets = allSets(summary)
  return {
    setCount: ex.reduce((n, e) => n + e.setCount, 0),
    workingSetCount: ex.reduce((n, e) => n + e.workingSetCount, 0),
    totalReps: ex.reduce((n, e) => n + e.totalReps, 0),
    volumeLbs: loaded.length ? loaded.reduce((n, e) => n + (e.volumeLbs ?? 0), 0) : null,
    unloadedSetLabels: sets.filter((s) => s.weightLbs === null).map((s) => s.loadLabel),
    lastSetEndedAt: sets.length ? sets[sets.length - 1].endedAt : null,
  }
}
