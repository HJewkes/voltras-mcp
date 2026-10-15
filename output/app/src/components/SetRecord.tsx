import { LbTag } from './LbTag'
import type { ExerciseSummary, SessionSet, SessionSummary, Unit } from '../types'
import { PURPOSE_LABEL, allSets, restBeforeMs, setOneRepMax } from '../derive'
import { formatClock, formatSeconds, formatSetLoad, formatVelocity, loadSummary, toUnit } from '../format'

interface RowCells {
  load: string
  usual: string
  loss: string
  best: string
  e1rm: string
  time: string
  rest: string
}

function cellsFor(set: SessionSet, session: SessionSet[], unit: Unit): RowCells {
  const e1rm = setOneRepMax(set)
  const rest = restBeforeMs(set, session)
  const range = set.expectedRepRange
  const durationMs = new Date(set.endedAt).getTime() - new Date(set.startedAt).getTime()
  return {
    load: formatSetLoad(set, unit),
    usual: range ? `${range.expectedLow}–${range.expectedHigh}` : '',
    loss: set.velocityLossPct === null ? 'no data' : `${set.velocityLossPct}%`,
    best: set.bestRepVelocity === null ? 'no data' : formatVelocity(set.bestRepVelocity),
    e1rm: e1rm === null ? '' : `${toUnit(e1rm, unit)} ${unit}`,
    time: `${formatClock(set.startedAt)} · ${formatSeconds(durationMs)}`,
    rest: rest === null ? '' : formatSeconds(rest),
  }
}

function RecordRow({ set, session, unit, isVerdictSet }: { set: SessionSet; session: SessionSet[]; unit: Unit; isVerdictSet: boolean }) {
  const c = cellsFor(set, session, unit)
  return (
    <tr className={`rec-${set.setPurpose}`}>
      <td className="num">#{set.index}{isVerdictSet && <span className="verdict-mark" title="Set the verdict reads"> ◆</span>}</td>
      <td>{PURPOSE_LABEL[set.setPurpose]}</td>
      <td className="num">{c.load}</td>
      <td className="num strong">{set.repCount}</td>
      <td className="num" title={set.expectedRepRange?.basis}>{c.usual}</td>
      <td className={`num${set.velocityLossPct === null ? ' is-absent' : ''}`}>{c.loss}</td>
      <td className={`num${set.bestRepVelocity === null ? ' is-absent' : ''}`}>{c.best}</td>
      <td className="num">{c.e1rm}</td>
      <td className="num">{c.time}</td>
      <td className="num">{c.rest}</td>
    </tr>
  )
}

function ExerciseRows({ exercise, session, unit }: { exercise: ExerciseSummary; session: SessionSet[]; unit: Unit }) {
  const basis = exercise.sets.find((s) => s.expectedRepRange)?.expectedRepRange?.basis
  return (
    <tbody>
      <tr className="rec-group">
        <th colSpan={10} scope="rowgroup">
          {exercise.name}
          <span className="rec-basis">
            {exercise.workingSetCount} working of {exercise.setCount} sets · {exercise.totalReps} reps · {loadSummary(exercise, unit)} · {exercise.bestRepVelocity === null ? 'no speed data' : `best ${formatVelocity(exercise.bestRepVelocity)}`}
          </span>
          {basis && (
            <span className="rec-basis">
              Usual reps: {basis}
              {unit === 'kg' && <LbTag />}
            </span>
          )}
        </th>
      </tr>
      {exercise.sets.map((s) => (
        <RecordRow key={s.id} set={s} session={session} unit={unit} isVerdictSet={s.index === exercise.verdictSetIndex} />
      ))}
    </tbody>
  )
}

/** The raw record for the wall: every set, grouped by exercise, lowest visual weight on the page. */
export function SetRecordTable({ summary, unit }: { summary: SessionSummary; unit: Unit }) {
  const session = allSets(summary)
  return (
    <section className="record" aria-labelledby="record-title">
      <h2 id="record-title" className="eyebrow">Every set</h2>
      <table className="record-table">
        <thead>
          <tr>
            <th>Set</th><th>Purpose</th><th>Load</th><th>Reps</th><th>Usual reps</th>
            <th>Velocity loss</th><th>Best rep</th><th>e1RM</th><th>Started · length</th><th>Rest before</th>
          </tr>
        </thead>
        {summary.exercises.map((e) => (
          <ExerciseRows key={e.exerciseId ?? e.name} exercise={e} session={session} unit={unit} />
        ))}
      </table>
      <p className="record-foot">◆ marks the set each verdict reads. e1RM is Epley (load × (1 + reps/30)) on loaded working sets, from this session only; no all-time records here. Effort (RIR) is withheld until it is fitted to your own sets.</p>
    </section>
  )
}

function detailParts(c: RowCells): string[] {
  return [
    `VL ${c.loss}`,
    `best ${c.best}`,
    c.e1rm && `e1RM ${c.e1rm}`,
    c.usual && `usual ${c.usual}`,
    c.rest && `rest ${c.rest}`,
  ].filter(Boolean)
}

/** Phone record: one compact line per set inside the exercise card. */
export function SetList({ exercise, session, unit }: { exercise: ExerciseSummary; session: SessionSet[]; unit: Unit }) {
  return (
    <details className="set-list" open>
      <summary>All {exercise.setCount} sets</summary>
      <ol>
        {exercise.sets.map((s) => {
          const c = cellsFor(s, session, unit)
          return (
            <li key={s.id} className={`rec-${s.setPurpose}`}>
              <span className="sl-index">#{s.index}{s.index === exercise.verdictSetIndex && ' ◆'}</span>
              <span className="sl-main">{s.repCount} × {c.load}</span>
              <span className="sl-purpose">{PURPOSE_LABEL[s.setPurpose]}</span>
              <span className="sl-detail">
                {detailParts(c).map((part) => (
                  <span key={part}>{part}</span>
                ))}
              </span>
            </li>
          )
        })}
      </ol>
    </details>
  )
}
