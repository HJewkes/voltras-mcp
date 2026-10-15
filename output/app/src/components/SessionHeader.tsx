import type { SessionSummary, Unit } from '../types'
import { sessionTotals } from '../derive'
import { formatClock, formatDate, formatDuration, formatLoad } from '../format'
import { UnitToggle } from './UnitToggle'

interface Props {
  summary: SessionSummary
  unit: Unit
  onUnitChange: (unit: Unit) => void
}

function timeLine(startedAt: string, endedAt: string | null, lastSetEndedAt: string | null): string {
  const start = formatClock(startedAt)
  if (endedAt) {
    const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
    return `${formatDate(startedAt)} · ${start}–${formatClock(endedAt)} · ${formatDuration(ms)}`
  }
  const lastSet = lastSetEndedAt ? ` · last set ${formatClock(lastSetEndedAt)}` : ''
  return `${formatDate(startedAt)} · started ${start}${lastSet} · no end time`
}

/** Volume only counts sets with a load; say which sets fell outside it rather than imply zero. */
function unloadedNote(labels: string[]): string | undefined {
  if (labels.length === 0) return undefined
  const kinds = [...new Set(labels)].join(', ')
  return `excl. ${labels.length} unloaded set${labels.length > 1 ? 's' : ''} (${kinds})`
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <span className="stat-note">{note}</span>}
      </dd>
    </div>
  )
}

export function SessionHeader({ summary, unit, onUnitChange }: Props) {
  const { session, exercises } = summary
  const totals = sessionTotals(summary)
  const isOpen = session.endedAt === null
  const volumeNote = unloadedNote(totals.unloadedSetLabels)
  return (
    <header className="session-header">
      <div className="session-heading">
        <h1>{isOpen ? 'Session not ended' : 'Session complete'}</h1>
        <p className="session-time">{timeLine(session.startedAt, session.endedAt, totals.lastSetEndedAt)}</p>
      </div>
      <dl className="session-stats">
        <Stat label="Exercises" value={String(exercises.length)} />
        <Stat label="Working sets" value={`${totals.workingSetCount}`} note={`of ${totals.setCount}`} />
        <Stat label="Reps" value={String(totals.totalReps)} />
        <Stat label="Volume" value={totals.volumeLbs === null ? 'none recorded' : formatLoad(totals.volumeLbs, unit)} note={volumeNote} />
        <div className="stat stat-withheld">
          <dt>Effort (RIR)</dt>
          <dd>
            withheld
            <span className="stat-note">until fitted to your own sets</span>
          </dd>
        </div>
      </dl>
      <UnitToggle unit={unit} onChange={onUnitChange} />
      {isOpen && (
        <p className="notice notice-open" role="status">
          <strong>Not ended.</strong> This session was never closed, so these numbers cover the sets recorded so far and may still change.
        </p>
      )}
    </header>
  )
}
