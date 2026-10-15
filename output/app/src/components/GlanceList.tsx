import type { ExerciseSummary, Unit } from '../types'
import { VERDICT_LABEL } from '../derive'
import { formatDelta, formatLoad } from '../format'
import { ToneGlyph } from './ToneGlyph'

function NextSummary({ exercise, unit }: { exercise: ExerciseSummary; unit: Unit }) {
  const p = exercise.progression
  if (!p) return <span className="glance-next is-absent">no recommendation</span>
  const change = p.delta === 0 ? 'hold' : formatDelta(p, unit)
  return (
    <span className="glance-next">
      <strong>{formatLoad(p.targetWeightLbs, unit)}</strong> {change}
    </span>
  )
}

/** Phone-only roll call: every exercise's verdict and next load before any detail. */
export function GlanceList({ exercises, unit }: { exercises: ExerciseSummary[]; unit: Unit }) {
  return (
    <nav className="glance" aria-label="Session at a glance">
      <ol>
        {exercises.map((e) => (
          <li key={e.exerciseId ?? e.name}>
            <a href={`#ex-${e.sets[0]?.index}`}>
              <span className="glance-name">{e.name}</span>
              <span className={`glance-verdict tone-text-${e.verdict?.tone ?? 'none'}`}>
                {e.verdict ? <ToneGlyph tone={e.verdict.tone} size={18} /> : null}
                {e.verdict ? VERDICT_LABEL[e.verdict.state] : 'No verdict'}
              </span>
              <NextSummary exercise={e} unit={unit} />
            </a>
          </li>
        ))}
      </ol>
    </nav>
  )
}
