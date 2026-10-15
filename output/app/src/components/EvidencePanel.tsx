import type { ExerciseSummary, Unit } from '../types'
import { fatigueTrend, strengthTrend, workingSets, type Trend } from '../derive'
import { toUnit } from '../format'
import { SetStrip } from './SetStrip'

function signedPct(value: number): string {
  const rounded = Math.round(value)
  if (rounded === 0) return 'held'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`
}

function FatigueFact({ exercise }: { exercise: ExerciseSummary }) {
  const trend = fatigueTrend(exercise)
  const worst = exercise.maxVelocityLossPct
  const blind = workingSets(exercise).filter((s) => s.velocityLossPct === null).length
  const blindNote = blind && worst !== null ? ` · ${blind} set${blind > 1 ? 's' : ''} without speed data` : ''
  let value: string
  if (exercise.workingSetCount === 0) value = 'no working sets'
  else if (worst === null) value = 'no speed data on working sets'
  else if (!trend) value = `worst ${worst}%${blindNote}`
  else value = `VL ${trend.first}% → ${trend.last}%${trend.last === worst ? '' : ` · worst ${worst}%`}${blindNote}`
  return <Fact label="Fatigue" value={value} absent={worst === null} />
}

function strengthValue(exercise: ExerciseSummary, trend: Trend | null, unit: Unit): string {
  if (trend) return `${toUnit(trend.first, unit)} → ${toUnit(trend.last, unit)} ${unit} · ${signedPct(trend.changePct)}`
  if (workingSets(exercise).length === 0) return 'no working sets'
  if (exercise.topWeightLbs === null) return 'no load recorded'
  return 'one loaded working set'
}

function StrengthFact({ exercise, unit }: { exercise: ExerciseSummary; unit: Unit }) {
  const trend = strengthTrend(exercise)
  return <Fact label="Strength (e1RM)" value={strengthValue(exercise, trend, unit)} absent={!trend} />
}

function Fact({ label, value, absent = false }: { label: string; value: string; absent?: boolean }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd className={absent ? 'is-absent' : undefined}>{value}</dd>
    </div>
  )
}

function UsualRange({ exercise }: { exercise: ExerciseSummary }) {
  const range = exercise.sets.find((s) => s.expectedRepRange)?.expectedRepRange
  if (!range) return null
  return <Fact label="Your usual here" value={`${range.expectedLow}–${range.expectedHigh} reps (${range.n} past sets)`} />
}

export function EvidencePanel({ exercise, unit }: { exercise: ExerciseSummary; unit: Unit }) {
  return (
    <div className="evidence">
      <SetStrip
        sets={exercise.sets}
        verdictSetIndex={exercise.verdictSetIndex}
        verdictTone={exercise.verdict?.tone ?? null}
        unit={unit}
      />
      <dl className="facts">
        <FatigueFact exercise={exercise} />
        <StrengthFact exercise={exercise} unit={unit} />
        <UsualRange exercise={exercise} />
      </dl>
    </div>
  )
}
