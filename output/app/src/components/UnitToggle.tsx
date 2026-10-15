import type { Unit } from '../types'

const UNITS: Unit[] = ['lb', 'kg']

export function UnitToggle({ unit, onChange }: { unit: Unit; onChange: (unit: Unit) => void }) {
  return (
    <div className="unit-toggle" role="radiogroup" aria-label="Load unit">
      {UNITS.map((u) => (
        <button key={u} type="button" role="radio" aria-checked={unit === u} onClick={() => onChange(u)}>
          {u}
        </button>
      ))}
    </div>
  )
}
