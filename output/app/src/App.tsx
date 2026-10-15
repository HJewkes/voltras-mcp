import { useEffect, useState } from 'react'
import current from '../../../fixtures/1-current.json'
import full from '../../../fixtures/2-full-session.json'
import edges from '../../../fixtures/3-edges.json'
import type { SessionSummary, Unit } from './types'
import { SessionPage } from './SessionPage'

const FIXTURES: Record<string, SessionSummary> = {
  '1': current as SessionSummary,
  '2': full as SessionSummary,
  '3': edges as SessionSummary,
}

const PHONE_QUERY = '(max-width: 760px)'

function useLayout(): 'wall' | 'phone' {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY)
    const onChange = () => setPhone(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return phone ? 'phone' : 'wall'
}

const params = new URLSearchParams(window.location.search)
document.documentElement.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark'

/** Fixture, unit and theme come from the URL: ?f=2&unit=kg&theme=light */
export default function App() {
  const summary = FIXTURES[params.get('f') ?? '1'] ?? FIXTURES['1']
  const [unit, setUnit] = useState<Unit>(params.get('unit') === 'kg' ? 'kg' : 'lb')
  const layout = useLayout()
  return (
    <div className={`shell shell-${layout}`}>
      {layout === 'wall' && <div className="chrome-bar" aria-label="Status bar placeholder" />}
      {layout === 'wall' && <div className="chrome-rail" aria-label="Navigation rail placeholder" />}
      <main className="content">
        <SessionPage summary={summary} unit={unit} onUnitChange={setUnit} layout={layout} />
      </main>
      {layout === 'phone' && <div className="chrome-phone-bar" aria-label="Navigation bar placeholder" />}
    </div>
  )
}
