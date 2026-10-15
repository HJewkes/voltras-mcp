import type { CSSProperties } from 'react'
import type { SessionSummary, Unit } from './types'
import { allSets } from './derive'
import { ExerciseRow } from './components/ExerciseRow'
import { GlanceList } from './components/GlanceList'
import { SessionHeader } from './components/SessionHeader'
import { SetRecordTable } from './components/SetRecord'

interface Props {
  summary: SessionSummary
  unit: Unit
  onUnitChange: (unit: Unit) => void
  layout: 'wall' | 'phone'
}

export function SessionPage({ summary, unit, onUnitChange, layout }: Props) {
  const sessionSets = allSets(summary)
  const stripSlots = Math.max(...summary.exercises.map((e) => e.sets.length))
  return (
    <div className={`session-page page-${layout}`}>
      <SessionHeader summary={summary} unit={unit} onUnitChange={onUnitChange} />
      {layout === 'phone' && summary.exercises.length > 1 && <GlanceList exercises={summary.exercises} unit={unit} />}
      <div className="exercise-list" style={{ '--strip-slots': stripSlots } as CSSProperties}>
        {summary.exercises.map((e) => (
          <ExerciseRow
            key={e.exerciseId ?? e.name}
            exercise={e}
            sessionId={summary.session.id}
            sessionSets={sessionSets}
            unit={unit}
            layout={layout}
          />
        ))}
      </div>
      {layout === 'wall' && <SetRecordTable summary={summary} unit={unit} />}
    </div>
  )
}
