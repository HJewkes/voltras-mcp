/**
 * CategoricalNav — NET-NEW shell component (Phase-2 seed).
 *
 * C's left rail: Live / Review / Program / Body. No Idle tab — idle is a
 * state of Live. Pure presentational; selection state lives in the App.
 */
import React from 'react';

export type NavKey = 'live' | 'review' | 'program' | 'body' | 'specimens';

const ITEMS: Array<{ key: NavKey; label: string; glyph: string }> = [
  { key: 'live', label: 'Live', glyph: '∿' },
  { key: 'review', label: 'Review', glyph: '▮▮' },
  { key: 'program', label: 'Program', glyph: '▦' },
  { key: 'body', label: 'Body', glyph: '☰' },
  { key: 'specimens', label: 'Specs', glyph: '▤' },
];

export function CategoricalNav({
  active,
  onSelect,
}: {
  active: NavKey;
  onSelect: (key: NavKey) => void;
}): React.JSX.Element {
  return (
    <nav className="r2-nav" aria-label="Dashboard sections">
      {ITEMS.map((it) => (
        <button
          key={it.key}
          type="button"
          className={`r2-nav-btn${active === it.key ? ' on' : ''}`}
          onClick={() => onSelect(it.key)}
          aria-current={active === it.key ? 'page' : undefined}
        >
          <span className="r2-nav-glyph" aria-hidden="true">
            {it.glyph}
          </span>
          <span className="r2-nav-label">{it.label}</span>
        </button>
      ))}
    </nav>
  );
}
