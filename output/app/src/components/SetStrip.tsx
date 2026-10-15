import type { SessionSet, SetPurpose, Tone, Unit } from '../types'
import { formatSetLoad } from '../format'

/** Bars top out at 40% loss; anything past VL30 is already near failure. */
const SCALE_MAX = 40
const THRESHOLDS = [10, 20, 30]
const PURPOSE_SHORT: Record<SetPurpose, string | null> = {
  working: null,
  warmup: 'warm',
  probe: 'probe',
  technique: 'tech',
}

interface Props {
  sets: SessionSet[]
  verdictSetIndex: number | null
  verdictTone: Tone | null
  unit: Unit
}

function LossBar({ set, highlightTone }: { set: SessionSet; highlightTone: Tone | null }) {
  if (set.velocityLossPct === null) {
    return <div className="bar-absent" title="No velocity telemetry for this set" />
  }
  const height = Math.min(set.velocityLossPct, SCALE_MAX) / SCALE_MAX
  const tone = highlightTone ? ` bar-tone-${highlightTone}` : ''
  return <div className={`bar bar-${set.setPurpose}${tone}`} style={{ height: `${height * 100}%` }} />
}

function SetColumn({ set, isVerdictSet, verdictTone, unit }: { set: SessionSet; isVerdictSet: boolean; verdictTone: Tone | null; unit: Unit }) {
  const purpose = PURPOSE_SHORT[set.setPurpose]
  return (
    <li className={`set-col set-${set.setPurpose}${isVerdictSet ? ' is-verdict-set' : ''}`}>
      <span className="set-loss">{set.velocityLossPct === null ? 'no data' : `${set.velocityLossPct}%`}</span>
      <div className="set-track">
        <LossBar set={set} highlightTone={isVerdictSet ? verdictTone : null} />
      </div>
      <span className="set-reps">{set.repCount}</span>
      <span className="set-load">{formatSetLoad(set, unit)}</span>
      <span className="set-index">
        #{set.index}
        {purpose && <span className="set-purpose"> {purpose}</span>}
        {isVerdictSet && <span title="The set the verdict reads"> ◆</span>}
      </span>
    </li>
  )
}

/** Evidence strip: one column per set, bar = velocity loss against the VL10/20/30 lines. */
export function SetStrip({ sets, verdictSetIndex, verdictTone, unit }: Props) {
  return (
    <div className="set-strip">
      <div className="strip-axis" aria-hidden="true">
        {THRESHOLDS.map((t) => (
          <span key={t} style={{ bottom: `${(t / SCALE_MAX) * 100}%` }}>VL{t}</span>
        ))}
      </div>
      <div className="strip-plot">
        <div className="strip-lines" aria-hidden="true">
          {THRESHOLDS.map((t) => (
            <span key={t} style={{ bottom: `${(t / SCALE_MAX) * 100}%` }} />
          ))}
        </div>
        <ol className="strip-sets">
          {sets.map((s) => (
            <SetColumn key={s.id} set={s} isVerdictSet={s.index === verdictSetIndex} verdictTone={verdictTone} unit={unit} />
          ))}
        </ol>
      </div>
    </div>
  )
}
