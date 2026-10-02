// Dev-only overlay entry, injected into index.html by the fidelity build (VW-431). Production never loads it.

import { useSyncExternalStore, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';

import { FIDELITY_KINDS, snapshot, subscribe } from './registry.js';

export const FIDELITY_PILL_LABEL = 'FIDELITY BUILD';

const PILL_STYLE: CSSProperties = {
  position: 'fixed',
  right: 12,
  bottom: 12,
  zIndex: 2147483647,
  padding: '4px 10px',
  borderRadius: 999,
  background: 'rgba(16, 16, 16, 0.85)',
  border: '1px solid currentColor',
  color: 'rgb(245, 197, 66)',
  font: '600 12px/1.4 system-ui, sans-serif',
  pointerEvents: 'none',
};

/** Always visible in a fidelity bundle, so a stray one on the wall is obvious on sight. */
export function FidelityPill(): React.JSX.Element {
  const { kinds } = useSyncExternalStore(subscribe, snapshot);
  const counts = FIDELITY_KINDS.map((kind) => `${kind} ${kinds[kind].instances}`).join(' · ');
  return (
    <div data-testid="fidelity-pill" style={PILL_STYLE}>
      {FIDELITY_PILL_LABEL} · {counts}
    </div>
  );
}

const host = document.createElement('div');
host.id = 'vmcp-fidelity-root';
document.body.appendChild(host);
createRoot(host).render(<FidelityPill />);
