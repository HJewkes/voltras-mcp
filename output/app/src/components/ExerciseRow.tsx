import type { ExerciseSummary, SessionSet, Unit } from '../types'
import { EvidencePanel } from './EvidencePanel'
import { NextTime } from './NextTime'
import { SetList } from './SetRecord'
import { ExerciseTitle, ExerciseTotals, VerdictBlock } from './VerdictBlock'

interface Props {
  exercise: ExerciseSummary
  sessionId: string
  sessionSets: SessionSet[]
  unit: Unit
  layout: 'wall' | 'phone'
}

/**
 * One exercise, read in the brief's priority order: verdict, evidence, next time,
 * and (phone only) its raw sets. On the wall the three blocks sit side by side.
 */
export function ExerciseRow({ exercise, sessionId, sessionSets, unit, layout }: Props) {
  const tone = exercise.verdict?.tone ?? 'none'
  return (
    <article className={`exercise exercise-${tone}`} id={`ex-${exercise.sets[0]?.index}`}>
      <div className="exercise-verdict">
        <ExerciseTitle exercise={exercise} />
        <VerdictBlock exercise={exercise} />
        {layout === 'phone' && <ExerciseTotals exercise={exercise} unit={unit} />}
      </div>
      <EvidencePanel exercise={exercise} unit={unit} />
      <NextTime exercise={exercise} sessionId={sessionId} unit={unit} />
      {layout === 'phone' && <SetList exercise={exercise} session={sessionSets} unit={unit} />}
    </article>
  )
}
