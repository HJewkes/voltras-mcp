import type { ExerciseSummary, LoadDrift, Progression, Unit } from '../types'
import { agreementOf, scoreAgainstTarget, workingSets, type Agreement, type RepOutcome } from '../derive'
import { formatDelta, formatLoad } from '../format'
import { LbTag } from './LbTag'

const OUTCOME_MARK: Record<RepOutcome, string> = { below: '↓', in: '✓', above: '↑' }
const OUTCOME_TITLE: Record<RepOutcome, string> = {
  below: 'below target',
  in: 'in target',
  above: 'above target',
}

function actionWords(p: Progression, unit: Unit): { arrow: string; words: string } {
  if (p.delta > 0) return { arrow: '▲', words: `Add ${formatDelta(p, unit).slice(1)}` }
  if (p.delta < 0) return { arrow: '▼', words: `Back off ${formatDelta(p, unit).slice(1)}` }
  return { arrow: '=', words: 'Hold' }
}

function RepPips({ exercise }: { exercise: ExerciseSummary }) {
  const p = exercise.progression
  const scored = scoreAgainstTarget(exercise)
  if (!p || scored.length === 0) return null
  const unscored = workingSets(exercise).length - scored.length
  return (
    <div className="rep-pips">
      <span className="pips-label">Reads reps vs {p.targetRepsLow}–{p.targetRepsHigh}:</span>
      <ol>
        {scored.map(({ set, outcome }) => (
          <li key={set.id} className={`pip pip-${outcome}`} title={`Set #${set.index}: ${set.repCount} reps, ${OUTCOME_TITLE[outcome]}`}>
            {set.repCount}
            <span aria-hidden="true">{OUTCOME_MARK[outcome]}</span>
          </li>
        ))}
      </ol>
      {unscored > 0 && <span className="pips-unscored">+{unscored} with no load, not scored</span>}
    </div>
  )
}

const AGREEMENT_TEXT: Record<Exclude<Agreement, 'agree'>, string> = {
  'speed-fine-reps-short': 'Verdict and plan differ: the bar moved well, but the reps fell short of target, so the load comes down.',
  'reps-fine-speed-dropped': 'Verdict and plan differ: the reps hit target, but the bar slowed. The plan still adds load; stop the set if speed drops early.',
}

function AgreementNote({ exercise }: { exercise: ExerciseSummary }) {
  const agreement = agreementOf(exercise)
  if (!agreement || agreement === 'agree') return null
  return (
    <p className="agreement-note">
      <span className="agreement-icon" aria-hidden="true">⇄</span>
      {AGREEMENT_TEXT[agreement]}
    </p>
  )
}

export function LoadDriftFlag({ drift, unit }: { drift: LoadDrift; unit: Unit }) {
  const easier = drift.deltaPct < 0
  return (
    <div className="drift-flag" role="note">
      <p className="drift-head">
        <span aria-hidden="true">{easier ? '▽' : '△'}</span> Load drift: {easier ? 'easier' : 'harder'} than planned, {drift.programmedPct}% → {drift.impliedPct}% of max ({drift.deltaPct > 0 ? '+' : '−'}{Math.abs(drift.deltaPct)} pts)
      </p>
      <p className="drift-reason">
        {drift.reason}
        {unit === 'kg' && <LbTag />}
      </p>
    </div>
  )
}

function Recommendation({ exercise, p, unit }: { exercise: ExerciseSummary; p: Progression; unit: Unit }) {
  const action = actionWords(p, unit)
  return (
    <>
      <p className="next-target">
        <span className="next-weight">{formatLoad(p.targetWeightLbs, unit)}</span>
        <span className="next-scheme">{p.targetSets} × {p.targetRepsLow}–{p.targetRepsHigh}</span>
        <span className="next-action">
          <span aria-hidden="true">{action.arrow}</span> {action.words}
        </span>
      </p>
      <RepPips exercise={exercise} />
      <AgreementNote exercise={exercise} />
      <p className="next-reasoning">
        <span className="source-tag">Plan</span> {p.reasoning}
        {unit === 'kg' && <LbTag />}
      </p>
    </>
  )
}

export function NextTime({ exercise, sessionId, unit }: { exercise: ExerciseSummary; sessionId: string; unit: Unit }) {
  const p = exercise.progression
  return (
    <div className="next">
      <p className="eyebrow">Next time</p>
      {p ? (
        <Recommendation exercise={exercise} p={p} unit={unit} />
      ) : (
        <>
          <p className="next-none">No recommendation</p>
          <p className="next-reasoning">{exercise.progressionNote ?? 'No recommendation was produced.'}</p>
        </>
      )}
      {p && p.basedOnSessionId !== sessionId && <p className="next-reasoning">Based on session {p.basedOnSessionId}.</p>}
      {exercise.loadDrift && <LoadDriftFlag drift={exercise.loadDrift} unit={unit} />}
    </div>
  )
}
