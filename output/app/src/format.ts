import type { ExerciseSummary, Progression, SessionSet, Unit } from './types'

const KG_PER_LB = 0.4536

export function toUnit(lbs: number, unit: Unit): number {
  return unit === 'kg' ? Math.round(lbs * KG_PER_LB) : Math.round(lbs)
}

export function formatLoad(lbs: number, unit: Unit): string {
  return `${toUnit(lbs, unit).toLocaleString('en-US')} ${unit}`
}

/** The server's loadLabel is written in lb; weighted sets are re-rendered in kg mode. */
export function formatSetLoad(set: SessionSet, unit: Unit): string {
  if (set.weightLbs === null) return set.loadLabel
  return unit === 'lb' ? set.loadLabel : formatLoad(set.weightLbs, unit)
}

/**
 * The change between the two loads as displayed, so the chip always matches the numbers on
 * screen (100 lb -> 105 lb shows as 45 -> 48 kg, so "+3 kg", not the 2.3 kg physical step).
 */
export function displayedDelta(progression: Progression, unit: Unit): number {
  const target = progression.targetWeightLbs
  return toUnit(target, unit) - toUnit(target - progression.delta, unit)
}

export function formatDelta(progression: Progression, unit: Unit): string {
  const d = displayedDelta(progression, unit)
  const sign = d > 0 ? '+' : d < 0 ? '−' : '±'
  return `${sign}${Math.abs(d)} ${unit}`
}

export function formatVelocity(mps: number): string {
  return `${mps.toFixed(2)} m/s`
}

const timeFmt = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
})

export function formatClock(iso: string): string {
  return timeFmt.format(new Date(iso))
}

export function formatDate(iso: string): string {
  return dateFmt.format(new Date(iso))
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 60) return `${totalMin} min`
  return `${Math.floor(totalMin / 60)} h ${totalMin % 60} min`
}

export function formatSeconds(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const rem = s % 60
  return rem === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m ${rem}s`
}

export function loadSummary(exercise: ExerciseSummary, unit: Unit): string {
  const { topWeightLbs, volumeLbs } = exercise
  if (topWeightLbs === null) return 'no load recorded'
  return `top ${formatLoad(topWeightLbs, unit)} · ${volumeLbs === null ? 'no volume' : `${formatLoad(volumeLbs, unit)} vol`}`
}
