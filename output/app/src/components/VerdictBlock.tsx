import type { ExerciseSummary, Tone, Unit } from '../types'
import { formatVelocity, loadSummary } from '../format'
import { TONE_WORD, VERDICT_LABEL, noVerdictReason } from '../derive'
import { ToneGlyph } from './ToneGlyph'

const DIMENSIONS: { key: 'velocityLoss' | 'rom' | 'tempo'; label: string; title: string }[] = [
  { key: 'velocityLoss', label: 'VEL', title: 'Velocity loss' },
  { key: 'rom', label: 'ROM', title: 'Range of motion' },
  { key: 'tempo', label: 'TEMPO', title: 'Tempo' },
]

function DimensionChip({ label, title, tone }: { label: string; title: string; tone: Tone }) {
  return (
    <li className={`dim-chip dim-${tone}`} title={`${title}: ${TONE_WORD[tone]}`}>
      <ToneGlyph tone={tone} size={16} />
      <span>{label}</span>
    </li>
  )
}

export function ExerciseTitle({ exercise }: { exercise: ExerciseSummary }) {
  const unattributed = exercise.exerciseId === null
  return (
    <header className="exercise-title">
      <h2 className={unattributed ? 'is-unattributed' : undefined}>{exercise.name}</h2>
      {unattributed && <p className="exercise-meta">These sets named no exercise.</p>}
    </header>
  )
}

/** Exercise totals, kept small under the verdict: they are record, not judgement. */
export function ExerciseTotals({ exercise, unit }: { exercise: ExerciseSummary; unit: Unit }) {
  const best = exercise.bestRepVelocity === null ? 'no speed data' : `best ${formatVelocity(exercise.bestRepVelocity)}`
  return (
    <div className="exercise-totals">
      <p className="exercise-meta">
        {exercise.workingSetCount} working of {exercise.setCount} sets · {exercise.totalReps} reps
      </p>
      <p className="exercise-meta">
        {loadSummary(exercise, unit)} · {best}
      </p>
    </div>
  )
}

export function VerdictBlock({ exercise }: { exercise: ExerciseSummary }) {
  const { verdict } = exercise
  if (!verdict) {
    return (
      <div className="verdict verdict-none">
        <p className="verdict-word">No verdict</p>
        <p className="verdict-reads">{noVerdictReason(exercise)}</p>
      </div>
    )
  }
  return (
    <div className={`verdict verdict-${verdict.tone}`}>
      <p className="verdict-word">
        <ToneGlyph tone={verdict.tone} size={36} />
        <span>{VERDICT_LABEL[verdict.state]}</span>
      </p>
      <ul className="dim-list" aria-label="Verdict dimensions">
        {DIMENSIONS.map((d) => (
          <DimensionChip key={d.key} label={d.label} title={d.title} tone={verdict.dimensions[d.key]} />
        ))}
      </ul>
      <p className="verdict-reads">◆ Reads set #{exercise.verdictSetIndex}, the worst working set</p>
    </div>
  )
}
